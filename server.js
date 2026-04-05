#!/usr/bin/env node
/**
 * HelpScout MCP Server — Remote HTTP Edition
 * Deploy this to any Node.js host (Render.com, etc.)
 *
 * Required environment variables:
 *   HELPSCOUT_APP_ID      — Help Scout App ID
 *   HELPSCOUT_APP_SECRET  — Help Scout App Secret
 *   MCP_API_KEY           — Secret key to protect this endpoint (you choose this)
 */

import express from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const APP_ID = process.env.HELPSCOUT_APP_ID;
const APP_SECRET = process.env.HELPSCOUT_APP_SECRET;
const API_KEY = process.env.MCP_API_KEY;
const PORT = process.env.PORT || 3000;
const BASE_URL = "https://api.helpscout.net/v2";

if (!APP_ID || !APP_SECRET) {
  console.error("Error: HELPSCOUT_APP_ID and HELPSCOUT_APP_SECRET are required.");
  process.exit(1);
}

// --- Token management ---
let accessToken = null;
let tokenExpiry = null;

async function getAccessToken() {
  if (accessToken && tokenExpiry && Date.now() < tokenExpiry) return accessToken;
  const response = await fetch(`${BASE_URL}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: APP_ID, client_secret: APP_SECRET }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Help Scout auth failed: ${response.status} ${text}`);
  }
  const data = await response.json();
  accessToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return accessToken;
}

async function apiRequest(method, path, body = null) {
  const token = await getAccessToken();
  const options = { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } };
  if (body !== null) options.body = JSON.stringify(body);
  const response = await fetch(`${BASE_URL}${path}`, options);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Help Scout API error ${response.status}: ${text}`);
  }
  if (response.status === 204 || response.headers.get("content-length") === "0") return { success: true };
  return response.json();
}

// --- MCP Server factory ---
function createMCPServer() {
  const server = new Server({ name: "helpscout", version: "0.2.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: "list_conversations", description: "List or search Help Scout conversations.", inputSchema: { type: "object", properties: { status: { type: "string", enum: ["active","closed","open","pending","spam"] }, query: { type: "string" }, mailboxId: { type: "number" }, assignedTo: { type: "number" }, page: { type: "number" } } } },
      { name: "get_conversation", description: "Get full details of a conversation.", inputSchema: { type: "object", properties: { conversation_id: { type: "number" } }, required: ["conversation_id"] } },
      { name: "reply_to_conversation", description: "Send a reply to a conversation.", inputSchema: { type: "object", properties: { conversation_id: { type: "number" }, text: { type: "string" }, cc: { type: "array", items: { type: "string" } }, bcc: { type: "array", items: { type: "string" } }, status: { type: "string", enum: ["active","closed","pending"] } }, required: ["conversation_id","text"] } },
      { name: "update_conversation", description: "Update a conversation status, tags, or assignee.", inputSchema: { type: "object", properties: { conversation_id: { type: "number" }, status: { type: "string", enum: ["active","closed","pending","spam"] }, subject: { type: "string" }, assignTo: { type: "number" }, tags: { type: "array", items: { type: "string" } } }, required: ["conversation_id"] } },
      { name: "add_note_to_conversation", description: "Add an internal note to a conversation.", inputSchema: { type: "object", properties: { conversation_id: { type: "number" }, text: { type: "string" } }, required: ["conversation_id","text"] } },
      { name: "list_customers", description: "List or search customers.", inputSchema: { type: "object", properties: { query: { type: "string" }, page: { type: "number" } } } },
      { name: "get_customer", description: "Get a customer's full profile.", inputSchema: { type: "object", properties: { customer_id: { type: "number" } }, required: ["customer_id"] } },
      { name: "create_customer", description: "Create a new customer.", inputSchema: { type: "object", properties: { email: { type: "string" }, firstName: { type: "string" }, lastName: { type: "string" }, phone: { type: "string" }, organization: { type: "string" }, notes: { type: "string" } }, required: ["email"] } },
      { name: "update_customer", description: "Update a customer's details.", inputSchema: { type: "object", properties: { customer_id: { type: "number" }, firstName: { type: "string" }, lastName: { type: "string" }, organization: { type: "string" }, notes: { type: "string" } }, required: ["customer_id"] } },
      { name: "get_report", description: "Get Help Scout analytics.", inputSchema: { type: "object", properties: { report_type: { type: "string", enum: ["company","conversation","productivity","team","user"] }, start: { type: "string" }, end: { type: "string" }, mailboxId: { type: "number" } }, required: ["report_type","start","end"] } },
      { name: "list_mailboxes", description: "List all mailboxes.", inputSchema: { type: "object", properties: {} } },
      { name: "list_users", description: "List all agents/users.", inputSchema: { type: "object", properties: {} } },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      let result;
      switch (name) {
        case "list_conversations": { const p = new URLSearchParams(); if (args.status) p.set("status",args.status); if (args.query) p.set("query",args.query); if (args.mailboxId) p.set("mailboxId",String(args.mailboxId)); if (args.assignedTo) p.set("assignedTo",String(args.assignedTo)); if (args.page) p.set("page",String(args.page)); result = await apiRequest("GET",`/conversations?${p}`); break; }
        case "get_conversation": result = await apiRequest("GET",`/conversations/${args.conversation_id}`); break;
        case "reply_to_conversation": { const body = { type:"reply", text:args.text }; if (args.cc) body.cc=args.cc; if (args.bcc) body.bcc=args.bcc; if (args.status) body.status=args.status; await apiRequest("POST",`/conversations/${args.conversation_id}/reply`,body); result = { success:true, message:"Reply sent." }; break; }
        case "update_conversation": { const { conversation_id, ...fields } = args; const ops = Object.entries(fields).map(([k,v]) => ({ op:"replace", path:`/${k}`, value:v })); await apiRequest("PATCH",`/conversations/${conversation_id}`,ops); result = { success:true }; break; }
        case "add_note_to_conversation": { await apiRequest("POST",`/conversations/${args.conversation_id}/notes`,{ type:"note", text:args.text }); result = { success:true }; break; }
        case "list_customers": { const p = new URLSearchParams(); if (args.query) p.set("query",args.query); if (args.page) p.set("page",String(args.page)); result = await apiRequest("GET",`/customers?${p}`); break; }
        case "get_customer": result = await apiRequest("GET",`/customers/${args.customer_id}`); break;
        case "create_customer": { const { email, ...rest } = args; result = await apiRequest("POST",`/customers`,{ ...rest, emails:[{ value:email, type:"work" }] }); break; }
        case "update_customer": { const { customer_id, ...data } = args; result = await apiRequest("PATCH",`/customers/${customer_id}`,data); break; }
        case "get_report": { const { report_type, start, end, mailboxId } = args; const p = new URLSearchParams({ start, end }); if (mailboxId) p.set("mailboxId",String(mailboxId)); result = await apiRequest("GET",`/reports/${report_type}?${p}`); break; }
        case "list_mailboxes": result = await apiRequest("GET",`/mailboxes`); break;
        case "list_users": result = await apiRequest("GET",`/users`); break;
        default: throw new Error(`Unknown tool: ${name}`);
      }
      return { content: [{ type:"text", text:JSON.stringify(result,null,2) }] };
    } catch (error) {
      return { content: [{ type:"text", text:`Error: ${error.message}` }], isError: true };
    }
  });

  return server;
}

// --- Express HTTP server ---
const app = express();
app.use(express.json());

// Health check
app.get("/", (req, res) => res.json({ status: "ok", service: "helpscout-mcp" }));

// MCP endpoint
app.post("/mcp", async (req, res) => {
  // Optional API key auth
  if (API_KEY) {
    const provided = req.headers["x-api-key"] || req.query.apiKey;
    if (provided !== API_KEY) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }
  try {
    const server = createMCPServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => server.close().catch(() => {}));
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`HelpScout MCP server running on port ${PORT}`));
