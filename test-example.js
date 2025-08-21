#!/usr/bin/env node

// 这是一个简单的MCP工具示例，用于测试MCPTester

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

class SimpleMCPServer {
  constructor() {
    this.server = new Server(
      {
        name: "simple-mcp-test",
        version: "1.0.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupToolHandlers();
  }

  setupToolHandlers() {
    // 列出可用工具
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: "add",
            description: "Add two numbers",
            inputSchema: {
              type: "object",
              properties: {
                a: { type: "number", description: "First number" },
                b: { type: "number", description: "Second number" },
              },
              required: ["a", "b"],
            },
          },
          {
            name: "multiply",
            description: "Multiply two numbers",
            inputSchema: {
              type: "object",
              properties: {
                x: { type: "number", description: "First number" },
                y: { type: "number", description: "Second number" },
              },
              required: ["x", "y"],
            },
          },
          {
            name: "greet",
            description: "Generate a greeting message",
            inputSchema: {
              type: "object",
              properties: {
                name: { type: "string", description: "Name to greet" },
                language: { 
                  type: "string", 
                  description: "Language for greeting",
                  enum: ["en", "zh", "es", "fr"],
                  default: "en"
                },
              },
              required: ["name"],
            },
          },
        ],
      };
    });

    // 处理工具调用
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      switch (name) {
        case "add":
          const sum = args.a + args.b;
          return {
            content: [
              {
                type: "text",
                text: `计算结果: ${args.a} + ${args.b} = ${sum}`,
              },
            ],
          };

        case "multiply":
          const product = args.x * args.y;
          return {
            content: [
              {
                type: "text",
                text: `计算结果: ${args.x} × ${args.y} = ${product}`,
              },
            ],
          };

        case "greet":
          const greetings = {
            en: `Hello, ${args.name}!`,
            zh: `你好，${args.name}！`,
            es: `¡Hola, ${args.name}!`,
            fr: `Bonjour, ${args.name}!`,
          };
          const greeting = greetings[args.language || "en"];
          return {
            content: [
              {
                type: "text",
                text: greeting,
              },
            ],
          };

        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    });
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("Simple MCP Test Server started");
  }
}

const server = new SimpleMCPServer();
server.run().catch(console.error);