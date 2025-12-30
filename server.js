import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const app = express();
app.use(express.json());
app.use(express.static('public'));

// Store MCP client instances
const mcpClients = new Map();

// Connect to an MCP server (SSE)
async function connectToSSEServer(serverId, url) {
  const client = new Client({
    name: 'mcp-groq-client',
    version: '1.0.0'
  }, {
    capabilities: {
      tools: {},
      resources: {},
      prompts: {}
    }
  });

  const transport = new SSEClientTransport(new URL(url));
  await client.connect(transport);
  mcpClients.set(serverId, client);
  
  return client;
}

// Connect to an MCP server (stdio)
async function connectToStdioServer(serverId, config) {
  const client = new Client({
    name: 'mcp-groq-client',
    version: '1.0.0'
  }, {
    capabilities: {
      tools: {},
      resources: {},
      prompts: {}
    }
  });

  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    env: config.env
  });

  await client.connect(transport);
  mcpClients.set(serverId, client);
  
  return client;
}

// Convert MCP tools to Groq/OpenAI format
function convertMCPToolsToGroq(mcpTools) {
  return mcpTools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description || '',
      parameters: tool.inputSchema || {
        type: 'object',
        properties: {},
        required: []
      }
    }
  }));
}

// API Routes

// Connect to a new MCP server
app.post('/api/servers', async (req, res) => {
  try {
    const { serverId, type, url, command, args, env } = req.body;
    
    if (mcpClients.has(serverId)) {
      return res.status(400).json({ error: 'Server already connected' });
    }

    if (type === 'sse') {
      await connectToSSEServer(serverId, url);
    } else if (type === 'stdio') {
      await connectToStdioServer(serverId, { command, args, env });
    } else {
      return res.status(400).json({ error: 'Invalid server type. Use "sse" or "stdio"' });
    }

    res.json({ success: true, serverId });
  } catch (error) {
    console.error('Connection error:', error);
    res.status(500).json({ error: error.message });
  }
});

// List all connected servers
app.get('/api/servers', (req, res) => {
  const servers = Array.from(mcpClients.keys());
  res.json({ servers });
});

// Disconnect from a server
app.delete('/api/servers/:serverId', async (req, res) => {
  try {
    const { serverId } = req.params;
    const client = mcpClients.get(serverId);
    
    if (!client) {
      return res.status(404).json({ error: 'Server not found' });
    }

    await client.close();
    mcpClients.delete(serverId);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// List available tools from a server
app.get('/api/servers/:serverId/tools', async (req, res) => {
  try {
    const { serverId } = req.params;
    const client = mcpClients.get(serverId);
    
    if (!client) {
      return res.status(404).json({ error: 'Server not found' });
    }

    const result = await client.listTools();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Chat with Groq (with MCP tool support and streaming)
app.post('/api/chat', async (req, res) => {
  try {
    const { 
      messages, 
      model, 
      apiKey, 
      serverId, 
      maxIterations = 5 
    } = req.body;

    if (!apiKey) {
      return res.status(400).json({ error: 'Groq API key required' });
    }

    // Set up SSE headers for streaming
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    let conversationMessages = [
      {
        role: "system",
        content: `You are a medical assistant with access to clinical decision support tools.

CRITICAL TOOL USAGE RULES:
1. When the user asks a medical question, you MUST use the available tools
2. ALWAYS fill ALL required parameters based on the information provided
3. you have to be perfect at doing assessment of gestational age based on comparison operators - like greater than, less than, between. for instance if there is a question about is GA between 24-34 weeks, that would be Yes for 32 weeks gestationa age, but No for 36 weeks. Double check your comparison answers for gestational age. 
4. normalize gestational ages to formal WW+D (ie, 34 weeks gestational age is 34+0 or 24 weeks and 4 days is 24+4)
//   - For Yes/No questions: Use "No" if not mentioned
//   - For "Yes - High Risk" / "No - Low Risk" questions: Use "No - Low Risk" if not mentioned
   - For "Not done" options: Only use when explicitly available in the schema
   - For text fields: Use "Not specified" or leave empty based on schema requirements

IMPORTANT: Review the tool parameter schemas carefully. Each parameter has specific allowed values.

Medical abbreviations you should recognize:
- UA: umbilical artery doppler
- UtA: uterine artery doppler  
- MCA: middle cerebral artery doppler
- CPR: cerebro-placental ratio
- FGR: fetal growth restriction
- SGA: small for gestational age
- PlGF: placental growth factor
- PI: pulsatility index

After receiving tool results, provide a clear response based ONLY on the tool output.
Do NOT add your own medical knowledge - only relay what the tools return.
When you provide the output, format it in pretty HTML.  Make sure to use a dark background and white text so that it is clear.`
      },
      ...messages
    ];
    
    let iterations = 0;
    const toolResults = [];

    const sendEvent = (event, data) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    while (iterations < maxIterations) {
      iterations++;

      // Get available tools from MCP server if specified
      let tools = null;
      if (serverId) {
        const client = mcpClients.get(serverId);
        if (client) {
          const mcpTools = await client.listTools();
          tools = convertMCPToolsToGroq(mcpTools.tools || []);
        }
      }

      // Call Groq API with streaming
      const groqResponse = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: model || 'llama-3.3-70b-versatile',
          messages: conversationMessages,
          tools: tools && tools.length > 0 ? tools : undefined,
          stream: true
        })
      });

      if (!groqResponse.ok) {
        const errorText = await groqResponse.text();
        let errorData;
        try {
          errorData = JSON.parse(errorText);
        } catch {
          errorData = { message: errorText };
        }
        
        // If it's a tool validation error, add it to conversation and retry
        if (errorData.error?.code === 'tool_use_failed') {
          console.error('Tool validation failed:', errorData.error.message);
          
          // Add error message to help the model correct itself
          conversationMessages.push({
            role: 'assistant',
            content: `I need to correct my tool call. The error was: ${errorData.error.message}`
          });
          
          sendEvent('error', { 
            message: `Tool validation error. Retrying... (${errorData.error.message})` 
          });
          
          // Continue to retry
          continue;
        }
        
        // For other errors, fail
        sendEvent('error', { message: `Groq API error: ${errorData.error?.message || errorText}` });
        res.end();
        return;
      }

      let fullContent = '';
      let toolCalls = [];
      const reader = groqResponse.body.getReader();
      const decoder = new TextDecoder();

      let buffer = '';
      
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        
        // Keep the last incomplete line in the buffer
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim() || !line.startsWith('data: ')) continue;
          
          const data = line.slice(6).trim();
          if (data === '[DONE]') continue;
          if (!data) continue;

          try {
            const parsed = JSON.parse(data);
            
            // Check if this is an error response
            if (parsed.error) {
              console.error('Groq API Error:', parsed.error);
              sendEvent('error', { message: `Groq API Error: ${JSON.stringify(parsed.error)}` });
              continue;
            }
            
            // Validate the response structure
            if (!parsed.choices || !Array.isArray(parsed.choices) || parsed.choices.length === 0) {
              console.warn('Unexpected response structure:', JSON.stringify(parsed).substring(0, 200));
              continue;
            }
            
            const delta = parsed.choices[0]?.delta;
            if (!delta) continue;

            if (delta?.content) {
              fullContent += delta.content;
              sendEvent('content', { content: delta.content });
            }

            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                if (!toolCalls[tc.index]) {
                  toolCalls[tc.index] = {
                    id: tc.id || '',
                    type: 'function',
                    function: { name: '', arguments: '' }
                  };
                }
                if (tc.function?.name) {
                  toolCalls[tc.index].function.name = tc.function.name;
                }
                if (tc.function?.arguments) {
                  toolCalls[tc.index].function.arguments += tc.function.arguments;
                }
                if (tc.id) {
                  toolCalls[tc.index].id = tc.id;
                }
              }
            }
          } catch (e) {
            // Only log if it's not just an incomplete chunk
            if (!data.includes('{') || data.endsWith('}')) {
              console.error('Error parsing stream chunk:', e.message);
              console.error('Problematic data:', data.substring(0, 200));
            }
          }
        }
      }

      const assistantMessage = {
        role: 'assistant',
        content: fullContent || null
      };

      if (toolCalls.length > 0) {
        assistantMessage.tool_calls = toolCalls;
        console.log('\n=== TOOL CALLS DETECTED ===');
        toolCalls.forEach((tc, idx) => {
          console.log(`Tool ${idx + 1}: ${tc.function.name}`);
          console.log(`Arguments length: ${tc.function.arguments.length} characters`);
          console.log(`First 200 chars: ${tc.function.arguments.substring(0, 200)}`);
          console.log(`Last 200 chars: ${tc.function.arguments.substring(tc.function.arguments.length - 200)}`);
        });
        console.log('========================\n');
      }

      conversationMessages.push(assistantMessage);

      // Check if the model wants to call tools
      if (toolCalls.length > 0) {
        sendEvent('tool_calls_start', { count: toolCalls.length });

        // Execute each tool call
        for (const toolCall of toolCalls) {
          const toolName = toolCall.function.name;
          let toolArgs;
          
          try {
            // Clean up the arguments string before parsing
            const argsString = toolCall.function.arguments.trim();
            
            // Check if we have complete JSON
            if (!argsString || argsString === '') {
              toolArgs = {};
            } else {
              toolArgs = JSON.parse(argsString);
            }
          } catch (jsonError) {
            console.error(`JSON parse error for tool ${toolName}:`, jsonError);
            console.error(`Raw arguments (length ${toolCall.function.arguments.length}):`, toolCall.function.arguments);
            
            // Try to fix common JSON issues
            try {
              // Remove any trailing incomplete data
              let cleanArgs = toolCall.function.arguments.trim();
              
              // Count braces to see if JSON is incomplete
              const openBraces = (cleanArgs.match(/{/g) || []).length;
              const closeBraces = (cleanArgs.match(/}/g) || []).length;
              
              if (openBraces > closeBraces) {
                // Add missing closing braces
                cleanArgs += '}'.repeat(openBraces - closeBraces);
              }
              
              // Try parsing again
              toolArgs = JSON.parse(cleanArgs);
              console.log('Successfully recovered JSON after adding missing braces');
            } catch (recoveryError) {
              console.error('Could not recover JSON:', recoveryError);
              
              // Add error to conversation so the model can retry with correct JSON
              conversationMessages.push({
                role: 'tool',
                tool_call_id: toolCall.id,
                content: JSON.stringify({ 
                  error: `JSON parsing failed: ${jsonError.message}. Please retry with valid JSON.`,
                  invalid_json: toolCall.function.arguments.substring(0, 500) + '...'
                })
              });
              
              continue;
            }
          }

          sendEvent('tool_call', { tool: toolName, arguments: toolArgs });

          console.log(`Calling tool: ${toolName} with args:`, toolArgs);

          // Call the MCP tool
          const client = mcpClients.get(serverId);
          if (!client) {
            sendEvent('error', { message: 'MCP server not connected' });
            res.end();
            return;
          }

          const result = await client.callTool({
            name: toolName,
            arguments: toolArgs
          });

          // Store tool result for response
          toolResults.push({
            tool: toolName,
            arguments: toolArgs,
            rawResult: result
          });

          sendEvent('tool_result', { 
            tool: toolName, 
            arguments: toolArgs,
            rawResult: result 
          });

          // Add tool result to conversation
          conversationMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify(result)
          });
        }

        sendEvent('tool_calls_end', {});

        // Continue the loop to get the final response
        continue;
      }

      // No more tool calls, send done event
      sendEvent('done', {
        conversationMessages: conversationMessages,
        toolResults: toolResults
      });
      res.end();
      return;
    }

    // Max iterations reached
    sendEvent('done', {
      message: 'Maximum iterations reached',
      conversationMessages: conversationMessages,
      toolResults: toolResults
    });
    res.end();

  } catch (error) {
    console.error('Chat error:', error);
    try {
      res.write(`event: error\ndata: ${JSON.stringify({ message: error.message })}\n\n`);
      res.end();
    } catch (e) {
      // Response already ended
    }
  }
});

// Call a tool directly (for testing)
app.post('/api/servers/:serverId/tools/:toolName/call', async (req, res) => {
  try {
    const { serverId, toolName } = req.params;
    const { arguments: toolArgs } = req.body;
    
    const client = mcpClients.get(serverId);
    
    if (!client) {
      return res.status(404).json({ error: 'Server not found' });
    }

    const result = await client.callTool({
      name: toolName,
      arguments: toolArgs || {}
    });
    
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// List available resources
app.get('/api/servers/:serverId/resources', async (req, res) => {
  try {
    const { serverId } = req.params;
    const client = mcpClients.get(serverId);
    
    if (!client) {
      return res.status(404).json({ error: 'Server not found' });
    }

    const result = await client.listResources();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Read a resource
app.post('/api/servers/:serverId/resources/read', async (req, res) => {
  try {
    const { serverId } = req.params;
    const { uri } = req.body;
    
    const client = mcpClients.get(serverId);
    
    if (!client) {
      return res.status(404).json({ error: 'Server not found' });
    }

    const result = await client.readResource({ uri });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// List available prompts
app.get('/api/servers/:serverId/prompts', async (req, res) => {
  try {
    const { serverId } = req.params;
    const client = mcpClients.get(serverId);
    
    if (!client) {
      return res.status(404).json({ error: 'Server not found' });
    }

    const result = await client.listPrompts();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get a prompt
app.post('/api/servers/:serverId/prompts/:promptName', async (req, res) => {
  try {
    const { serverId, promptName } = req.params;
    const { arguments: promptArgs } = req.body;
    
    const client = mcpClients.get(serverId);
    
    if (!client) {
      return res.status(404).json({ error: 'Server not found' });
    }

    const result = await client.getPrompt({
      name: promptName,
      arguments: promptArgs || {}
    });
    
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    connectedServers: mcpClients.size 
  });
});

// Cleanup on shutdown
process.on('SIGTERM', async () => {
  console.log('Shutting down...');
  for (const [serverId, client] of mcpClients) {
    try {
      await client.close();
      console.log(`Closed connection to ${serverId}`);
    } catch (error) {
      console.error(`Error closing ${serverId}:`, error);
    }
  }
  process.exit(0);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`MCP Groq Client running on ${PORT}`);
});
