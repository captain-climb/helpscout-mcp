import express from 'express';

const app = express();
app.use(express.json());
app.get('/mcp', (req, res) => {
     res.setHeader('Content-Type', 'text/event-stream');
     res.setHeader('Cache-Control', 'no-cache');
     res.flushHeaders();
     const ka = setInterval(() => res.write(': ping\n\n'), 20000);
     req.on('close', () => clearInterval(ka));
   });
const PORT = process.env.PORT || 3000;
const MCP_API_KEY = process.env.MCP_API_KEY || 'helpscout-mcp-secret-2024';
const HELPSCOUT_APP_ID = process.env.HELPSCOUT_APP_ID;
const HELPSCOUT_APP_SECRET = process.env.HELPSCOUT_APP_SECRET;

if (!HELPSCOUT_APP_ID || !HELPSCOUT_APP_SECRET) {
  console.error('Error: HELPSCOUT_APP_ID and HELPSCOUT_APP_SECRET are required.');
  process.exit(1);
}

// HelpScout OAuth token cache
let tokenCache = { token: null, expiresAt: 0 };

async function getHelpScoutToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt - 60000) {
    return tokenCache.token;
  }
  const resp = await fetch('https://api.helpscout.net/v2/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: HELPSCOUT_APP_ID,
      client_secret: HELPSCOUT_APP_SECRET,
    }),
  });
  if (!resp.ok) throw new Error(`HelpScout auth failed: ${resp.status}`);
  const data = await resp.json();
  tokenCache.token = data.access_token;
  tokenCache.expiresAt = Date.now() + data.expires_in * 1000;
  return tokenCache.token;
}

async function hsGet(path, params = {}) {
  const token = await getHelpScoutToken();
  const url = new URL(`https://api.helpscout.net/v2${path}`);
  Object.entries(params).forEach(([k, v]) => v !== undefined && v !== null && url.searchParams.set(k, String(v)));
  const resp = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) throw new Error(`HelpScout GET ${path} failed: ${resp.status}`);
  return resp.json();
}

async function hsPost(path, body) {
  const token = await getHelpScoutToken();
  const resp = await fetch(`https://api.helpscout.net/v2${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) { const t = await resp.text(); throw new Error(`HelpScout POST ${path} failed: ${resp.status} ${t}`); }
  if (resp.status === 204) return { success: true };
  return resp.json();
}

async function hsPatch(path, body) {
  const token = await getHelpScoutToken();
  const resp = await fetch(`https://api.helpscout.net/v2${path}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) { const t = await resp.text(); throw new Error(`HelpScout PATCH ${path} failed: ${resp.status} ${t}`); }
  if (resp.status === 204) return { success: true };
  return resp.json();
}

// Tool definitions
const TOOLS = [
  {
    name: 'list_mailboxes',
    description: 'List all Help Scout mailboxes',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'list_users',
    description: 'List all Help Scout users/agents',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'list_conversations',
    description: 'List or search Help Scout conversations',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['active', 'closed', 'pending', 'spam', 'all'], description: 'Conversation status filter' },
        query: { type: 'string', description: 'Search query' },
        mailboxId: { type: 'number', description: 'Filter by mailbox ID' },
        page: { type: 'number', description: 'Page number' },
      },
    },
  },
  {
    name: 'get_conversation',
    description: 'Get a full Help Scout conversation including all threads',
    inputSchema: {
      type: 'object',
      properties: { conversationId: { type: 'number', description: 'Conversation ID' } },
      required: ['conversationId'],
    },
  },
  {
    name: 'reply_to_conversation',
    description: 'Send a customer-facing reply to a conversation',
    inputSchema: {
      type: 'object',
      properties: {
        conversationId: { type: 'number', description: 'Conversation ID' },
        body: { type: 'string', description: 'Reply body text' },
        status: { type: 'string', enum: ['active', 'closed', 'pending'], description: 'Set conversation status after reply' },
      },
      required: ['conversationId', 'body'],
    },
  },
  {
    name: 'add_note_to_conversation',
    description: 'Add an internal note to a conversation (not visible to customer)',
    inputSchema: {
      type: 'object',
      properties: {
        conversationId: { type: 'number', description: 'Conversation ID' },
        body: { type: 'string', description: 'Note body' },
      },
      required: ['conversationId', 'body'],
    },
  },
  {
    name: 'update_conversation',
    description: 'Update a conversation status, subject, tags, or assignee',
    inputSchema: {
      type: 'object',
      properties: {
        conversationId: { type: 'number', description: 'Conversation ID' },
        status: { type: 'string', enum: ['active', 'closed', 'pending', 'spam'] },
        subject: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Full list of tags (replaces existing)' },
        assignTo: { type: 'number', description: 'User ID to assign to' },
      },
      required: ['conversationId'],
    },
  },
  {
    name: 'list_customers',
    description: 'Search Help Scout customers by name or email',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search by name, email, or phone' },
        page: { type: 'number' },
      },
    },
  },
  {
    name: 'get_customer',
    description: 'Get a Help Scout customer profile by ID',
    inputSchema: {
      type: 'object',
      properties: { customerId: { type: 'number', description: 'Customer ID' } },
      required: ['customerId'],
    },
  },
  {
    name: 'create_customer',
    description: 'Create a new Help Scout customer',
    inputSchema: {
      type: 'object',
      properties: {
        email: { type: 'string', description: 'Customer email address' },
        firstName: { type: 'string' },
        lastName: { type: 'string' },
        phone: { type: 'string' },
      },
      required: ['email'],
    },
  },
  {
    name: 'update_customer',
    description: 'Update an existing Help Scout customer',
    inputSchema: {
      type: 'object',
      properties: {
        customerId: { type: 'number', description: 'Customer ID' },
        firstName: { type: 'string' },
        lastName: { type: 'string' },
      },
      required: ['customerId'],
    },
  },
  {
    name: 'get_report',
    description: 'Pull Help Scout analytics report',
    inputSchema: {
      type: 'object',
      properties: {
        reportType: { type: 'string', enum: ['company', 'productivity', 'team', 'user', 'conversation'] },
        start: { type: 'string', description: 'Start date ISO 8601 e.g. 2025-01-01T00:00:00Z' },
        end: { type: 'string', description: 'End date ISO 8601 e.g. 2025-01-31T23:59:59Z' },
      },
      required: ['reportType', 'start', 'end'],
    },
  },
];

// Tool execution
async function callTool(name, args) {
  switch (name) {
    case 'list_mailboxes':
      return await hsGet('/mailboxes');
    case 'list_users':
      return await hsGet('/users');
    case 'list_conversations':
      return await hsGet('/conversations', args);
    case 'get_conversation': {
      const [conv, threads] = await Promise.all([
        hsGet(`/conversations/${args.conversationId}`),
        hsGet(`/conversations/${args.conversationId}/threads`),
      ]);
      return { ...conv, threads };
    }
    case 'reply_to_conversation': {
      const payload = { type: 'reply', body: args.body };
      if (args.status) payload.status = args.status;
      return await hsPost(`/conversations/${args.conversationId}/reply`, payload);
    }
    case 'add_note_to_conversation':
      return await hsPost(`/conversations/${args.conversationId}/notes`, { body: args.body });
    case 'update_conversation': {
      const ops = [];
      if (args.status) ops.push({ op: 'replace', path: '/status', value: args.status });
      if (args.subject) ops.push({ op: 'replace', path: '/subject', value: args.subject });
      if (args.tags) ops.push({ op: 'replace', path: '/tags', value: args.tags.map(t => ({ name: t })) });
      if (args.assignTo) ops.push({ op: 'replace', path: '/assignTo', value: args.assignTo });
      return await hsPatch(`/conversations/${args.conversationId}`, ops);
    }
    case 'list_customers':
      return await hsGet('/customers', args);
    case 'get_customer':
      return await hsGet(`/customers/${args.customerId}`);
    case 'create_customer': {
      const payload = { emails: [{ value: args.email, type: 'work' }] };
      if (args.firstName) payload.firstName = args.firstName;
      if (args.lastName) payload.lastName = args.lastName;
      if (args.phone) payload.phones = [{ value: args.phone, type: 'work' }];
      return await hsPost('/customers', payload);
    }
    case 'update_customer': {
      const payload = {};
      if (args.firstName) payload.firstName = args.firstName;
      if (args.lastName) payload.lastName = args.lastName;
      return await hsPatch(`/customers/${args.customerId}`, payload);
    }
    case 'get_report':
      return await hsGet(`/reports/${args.reportType}`, { start: args.start, end: args.end });
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'helpscout-mcp' });
});

// MCP JSON-RPC endpoint
app.post('/mcp', async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  let id;
  try {
    // Auth check
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== MCP_API_KEY) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const body = req.body || {};
    id = body.id;
    const { method, params } = body;

    let result;

    if (method === 'initialize') {
      result = {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'helpscout-mcp', version: '1.0.0' },
      };
    } else if (method === 'notifications/initialized') {
      return res.status(204).end();
    } else if (method === 'tools/list') {
      result = { tools: TOOLS };
    } else if (method === 'tools/call') {
      const { name, arguments: args } = params;
      const toolResult = await callTool(name, args || {});
      result = {
        content: [{ type: 'text', text: JSON.stringify(toolResult, null, 2) }],
      };
    } else if (method === 'ping') {
      result = {};
    } else {
      return res.json({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      });
    }

    res.json({ jsonrpc: '2.0', id, result });
  } catch (err) {
    console.error('MCP error:', err.message);
    res.json({
      jsonrpc: '2.0',
      id,
      error: { code: -32000, message: err.message },
    });
  }
});

app.listen(PORT, () => {
  console.log(`HelpScout MCP server running on port ${PORT}`);
});
