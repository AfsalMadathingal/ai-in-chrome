// Tool definitions (MCP schemas). Names and `computer` actions mirror Claude in Chrome.
const tabId = { type: 'number', description: 'Tab ID. Defaults to the current AI tab, else the active tab.' };
const coordinate = { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2, description: '[x, y] in screenshot pixels' };

export const TOOLS = [
  {
    name: 'tabs_context',
    description: 'List open tabs with their IDs, titles and URLs. Shows which tab is current/active and which are in the AI tab group.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'tabs_create',
    description: 'Open a new tab (added to the "AI" tab group) and make it the current tab.',
    inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'URL to open (optional)' } } },
  },
  {
    name: 'tabs_select',
    description: 'Activate a tab and make it the current tab for later commands.',
    inputSchema: { type: 'object', properties: { tabId }, required: ['tabId'] },
  },
  {
    name: 'tabs_close',
    description: 'Close a tab.',
    inputSchema: { type: 'object', properties: { tabId }, required: ['tabId'] },
  },
  {
    name: 'navigate',
    description: 'Navigate a tab to a URL and wait for it to load. Use "back", "forward" or "reload" for history.',
    inputSchema: { type: 'object', properties: { url: { type: 'string' }, tabId }, required: ['url'] },
  },
  {
    name: 'computer',
    description:
      'Use mouse and keyboard on a tab and take screenshots. Actions: screenshot, left_click, right_click, double_click, ' +
      'triple_click, hover, left_click_drag, type, key, scroll, scroll_to, wait, zoom. Coordinates are pixels in the ' +
      'latest screenshot; alternatively pass a ref from read_page/find. Take a screenshot first to see the page.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['screenshot', 'left_click', 'right_click', 'double_click', 'triple_click', 'hover', 'left_click_drag',
            'type', 'key', 'scroll', 'scroll_to', 'wait', 'zoom'],
        },
        coordinate,
        start_coordinate: { ...coordinate, description: 'Drag start [x, y] (left_click_drag)' },
        ref: { type: 'string', description: 'Element ref (e.g. ref_12) from read_page/find, instead of coordinate' },
        text: { type: 'string', description: 'Text to type, or keys for "key" (e.g. "Enter", "cmd+a", "Tab Tab Enter")' },
        modifiers: { type: 'string', description: 'Modifier keys held during a click, e.g. "shift" or "cmd+shift"' },
        repeat: { type: 'number', description: 'Times to repeat the key sequence (key)' },
        scroll_direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
        scroll_amount: { type: 'number', description: 'Scroll ticks (100px each), default 3' },
        duration: { type: 'number', description: 'Seconds to wait (wait), max 30' },
        region: { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4, description: '[x0, y0, x1, y1] to zoom into' },
        tabId,
      },
      required: ['action'],
    },
  },
  {
    name: 'read_page',
    description: 'Accessibility-tree snapshot of the page with element refs (ref_N) usable in computer/form_input. filter "interactive" lists only controls.',
    inputSchema: {
      type: 'object',
      properties: {
        filter: { type: 'string', enum: ['all', 'interactive'] },
        depth: { type: 'number', description: 'Max tree depth (default 15)' },
        ref_id: { type: 'string', description: 'Only return the subtree under this ref' },
        tabId,
      },
    },
  },
  {
    name: 'find',
    description: 'Find elements whose role/name/attributes match the query words. Returns matching lines with refs.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, tabId }, required: ['query'] },
  },
  {
    name: 'form_input',
    description: 'Set a form field value by ref: text inputs, textareas, selects (by value or label), checkboxes/radios (true/false).',
    inputSchema: {
      type: 'object',
      properties: { ref: { type: 'string' }, value: { type: ['string', 'number', 'boolean'] }, tabId },
      required: ['ref', 'value'],
    },
  },
  {
    name: 'get_page_text',
    description: 'Get the readable text of the page (article/main/body).',
    inputSchema: { type: 'object', properties: { max_chars: { type: 'number' }, tabId } },
  },
  {
    name: 'javascript_tool',
    description: 'Evaluate JavaScript in the page (main world) and return the result. Top-level await is supported.',
    inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'JavaScript code' }, tabId }, required: ['text'] },
  },
  {
    name: 'read_console_messages',
    description: 'Read console messages, exceptions and auto-accepted dialogs captured since AI in Chrome attached to the tab.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex filter' },
        onlyErrors: { type: 'boolean' },
        limit: { type: 'number' },
        clear: { type: 'boolean' },
        tabId,
      },
    },
  },
  {
    name: 'read_network_requests',
    description:
      'List network requests captured on the tab (XHR/fetch, documents, scripts, WebSockets…) with #id, method, status, type, size and time. ' +
      'Then use network_request with the #id for full headers (incl. Cookie / Authorization), bodies, or a curl command.',
    inputSchema: {
      type: 'object',
      properties: {
        urlPattern: { type: 'string', description: 'Substring, or /regex/flags' },
        type: { type: 'string', description: 'Resource type filter, e.g. "fetch,xhr", "document", "websocket"' },
        method: { type: 'string', description: 'e.g. POST' },
        status: { type: 'string', description: 'e.g. 200, 4xx, 5xx, or "error" (failed or >= 400)' },
        limit: { type: 'number', description: 'Most recent N (default 100)' },
        clear: { type: 'boolean' },
        tabId,
      },
    },
  },
  {
    name: 'network_request',
    description:
      'Full details of one captured request: real request headers as sent (Cookie, Authorization, tokens), request body, ' +
      'response headers (incl. Set-Cookie), response body, timing, WebSocket frames. format "curl" or "fetch" gives a ready-to-run command.',
    inputSchema: {
      type: 'object',
      properties: {
        requestId: { type: ['number', 'string'], description: 'The #id from read_network_requests' },
        format: { type: 'string', enum: ['text', 'curl', 'fetch', 'json'] },
        includeBody: { type: 'boolean', description: 'Include the response body (default true)' },
        maxBodyChars: { type: 'number', description: 'Truncate bodies (default 20000)' },
        save_path: { type: 'string', description: 'Save the response body to this file or folder (binary-safe)' },
      },
      required: ['requestId'],
    },
  },
  {
    name: 'http_request',
    description:
      "Send an HTTP request as the logged-in browser user, or replay/edit a captured one (from=#id). via: \"page\" runs fetch inside the tab " +
      '(its cookies, origin, CSRF context; CORS applies), "extension" fetches without CORS with browser cookies, "node" sends from the ' +
      'local machine with any header you want plus the browser\'s cookies (incl. HttpOnly). Default "auto": page for same-origin URLs, else node.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        method: { type: 'string', description: 'Default GET, or POST when there is a body' },
        headers: { type: 'object', description: 'Headers to set; null removes one copied from a captured request' },
        body: { type: ['string', 'object'], description: 'Request body; objects are sent as JSON' },
        from: { type: ['number', 'string'], description: 'Replay captured request #id; url/method/headers/body override it' },
        via: { type: 'string', enum: ['auto', 'page', 'extension', 'node'] },
        cookies: { type: 'boolean', description: 'node: attach the browser cookies for the URL (default true)' },
        follow: { type: 'boolean', description: 'Follow redirects (default true)' },
        format: { type: 'string', enum: ['text', 'json'] },
        maxBodyChars: { type: 'number' },
        save_path: { type: 'string', description: 'Save the response body to this file or folder' },
        tabId,
      },
    },
  },
  {
    name: 'cookies',
    description: 'Read, set or delete cookies, including HttpOnly ones. get: for the page (or url), or every cookie of a domain.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'set', 'delete'] },
        url: { type: 'string' },
        domain: { type: 'string', description: 'get: all cookies for this domain and its subdomains' },
        name: { type: 'string' },
        value: { type: 'string' },
        path: { type: 'string' },
        secure: { type: 'boolean' },
        httpOnly: { type: 'boolean' },
        sameSite: { type: 'string', enum: ['Strict', 'Lax', 'None'] },
        expires: { type: ['number', 'string'], description: 'Unix seconds or a date string; omit for a session cookie' },
        format: { type: 'string', enum: ['text', 'header', 'json'], description: 'get: "header" gives a Cookie header value' },
        tabId,
      },
    },
  },
  {
    name: 'network_intercept',
    description:
      'Intercept the tab\'s requests live with rules (first match wins, they stay until removed). type "block" fails matching requests; ' +
      '"mock" answers them without hitting the server (status, body, responseHeaders; CORS handled); "modify" changes the request ' +
      '(url, method, headers, postData) and/or the response (status, responseHeaders, body, replace). delayMs slows requests down.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'list', 'remove', 'clear'] },
        pattern: { type: 'string', description: 'URL glob with * and ?, e.g. "*api/user*"; without wildcards it matches as a substring' },
        type: { type: 'string', enum: ['block', 'mock', 'modify'] },
        onlyMethod: { type: 'string', description: 'Only match this HTTP method' },
        resourceType: { type: 'string', description: 'Only match this type: Document, Script, XHR, Fetch, Image, Stylesheet…' },
        url: { type: 'string', description: 'modify: send the request to this URL instead' },
        method: { type: 'string', description: 'modify: change the HTTP method' },
        headers: { type: 'object', description: 'modify: request headers to set (null removes one)' },
        postData: { type: ['string', 'object'], description: 'modify: replace the request body' },
        status: { type: 'number', description: 'mock/modify: response status' },
        responseHeaders: { type: 'object', description: 'mock/modify: response headers to set (null removes one)' },
        body: { type: ['string', 'object'], description: 'mock/modify: response body (objects become JSON)' },
        replace: { type: 'array', description: 'modify: [[find, replace], …] on the response text; find may be "/regex/flags"' },
        errorReason: { type: 'string', description: 'block: Failed, Aborted, TimedOut, AccessDenied, ConnectionRefused, BlockedByClient (default)…' },
        delayMs: { type: 'number', description: 'Hold matching requests this long before sending (max 60000)' },
        times: { type: 'number', description: 'Remove the rule after this many hits' },
        ruleId: { type: 'string', description: 'remove: rule id, e.g. r2' },
        tabId,
      },
      required: ['action'],
    },
  },
  {
    name: 'network_export',
    description: 'Export captured requests as a HAR file (opens in Chrome DevTools, Charles, Postman…). Contains cookies and tokens.',
    inputSchema: {
      type: 'object',
      properties: {
        urlPattern: { type: 'string' },
        includeBodies: { type: 'boolean', description: 'Default true' },
        save_path: { type: 'string', description: 'File or folder (default ~/Downloads)' },
        tabId,
      },
    },
  },
  {
    name: 'resize_window',
    description: "Resize the tab's browser window.",
    inputSchema: { type: 'object', properties: { width: { type: 'number' }, height: { type: 'number' }, tabId }, required: ['width', 'height'] },
  },
  {
    name: 'cdp_command',
    description: 'Send a raw Chrome DevTools Protocol command to a tab (escape hatch), e.g. method "Page.reload".',
    inputSchema: { type: 'object', properties: { method: { type: 'string' }, params: { type: 'object' }, tabId }, required: ['method'] },
  },
  {
    name: 'extension_reload',
    description: 'Reload the AI in Chrome extension so it picks up code changes from disk.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'gif_creator',
    description:
      'Record browser actions as an animated GIF with click markers, drag paths, action labels, progress bar and watermark. ' +
      'Actions: start_recording (then take a screenshot for the first frame), stop_recording (take a screenshot just before), ' +
      'export (saves the GIF to save_path, default ~/Downloads; or download:true for Chrome downloads; or coordinate to drop it on the page), clear.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start_recording', 'stop_recording', 'export', 'clear'] },
        save_path: { type: 'string', description: 'export: file or folder to save the GIF to (default ~/Downloads)' },
        download: { type: 'boolean', description: "export: save via Chrome's downloads instead" },
        coordinate: { ...coordinate, description: 'export: drop the GIF onto the page at [x, y] (screenshot pixels)' },
        filename: { type: 'string' },
        options: {
          type: 'object',
          description: 'showClickIndicators, showDragPaths, showActionLabels, showProgressBar, showWatermark (default true), quality (1-30, lower = better, default 10)',
        },
        tabId,
      },
      required: ['action'],
    },
  },
  {
    name: 'file_upload',
    description:
      'Upload local files into an <input type="file"> by ref (find it with read_page/find; it is often hidden). ' +
      'Do not click upload buttons: that opens a native file picker you cannot control. Max 10 MB total.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'ref of the file input' },
        paths: { type: 'array', items: { type: 'string' }, description: 'Local file paths to upload' },
        files: {
          type: 'array',
          description: 'Alternatively, file contents: [{ name, data (base64), mimeType }]',
          items: { type: 'object', properties: { name: { type: 'string' }, data: { type: 'string' }, mimeType: { type: 'string' } }, required: ['name', 'data'] },
        },
        tabId,
      },
      required: ['ref'],
    },
  },
  {
    name: 'upload_image',
    description:
      'Upload an image to a file input (ref) or drop it onto a drop zone (coordinate, e.g. Google Docs). ' +
      'The image is a screenshot by its image ID (shown in the screenshot result) or a local file path.',
    inputSchema: {
      type: 'object',
      properties: {
        imageId: { type: 'string', description: 'Screenshot image ID, e.g. shot_3' },
        path: { type: 'string', description: 'Local image file instead of a screenshot' },
        ref: { type: 'string' },
        coordinate,
        filename: { type: 'string' },
        tabId,
      },
    },
  },
  {
    name: 'sidepanel_wait',
    description:
      'Listen to the AI in Chrome side panel: waits until the user sends a message from the panel in Chrome and returns it ' +
      '(with the tab it is about). Do the task with the browser tools, answer with sidepanel_reply, then call sidepanel_wait again. ' +
      'Use when the user asks you to listen to / connect to the side panel.',
    inputSchema: { type: 'object', properties: { timeout: { type: 'number', description: 'Seconds to wait (default 600)' } } },
  },
  {
    name: 'sidepanel_reply',
    description: 'Show your answer to the side panel message you received from sidepanel_wait (Markdown). done:false posts a progress update and keeps the turn open.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' }, done: { type: 'boolean' } }, required: ['text'] },
  },
  {
    name: 'approve_action',
    description: 'Internal: permission prompt for the side panel\'s Claude Code. Asks the user in the panel. Do not call directly.',
    inputSchema: {
      type: 'object',
      properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } },
      required: ['tool_name'],
    },
  },
];
