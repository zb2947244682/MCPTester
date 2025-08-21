# MCP Tester Server

## 项目介绍

这是一个专为 MCP (Model Context Protocol) 服务设计的测试工具。它提供了一套全面的功能，用于验证 MCP 服务器的连接、初始化、工具schema、功能正确性，并能进行性能基准测试和负面用例测试。

## 项目功能

此 MCP Tester 服务提供了以下测试工具：

-   `test_mcp_server`: 测试指定的 MCP 服务器，检查其工具列表和基本功能。
-   `validate_mcp_tools`: 验证 MCP 工具的 schema 和功能完整性。
-   `benchmark_mcp_performance`: 对 MCP 服务器进行性能基准测试。
-   `generate_mcp_test_report`: 生成 MCP 工具的详细测试报告，支持自定义内容和格式。
-   `mock_mcp_client`: 模拟 MCP 客户端，发送自定义请求测试服务器响应。
-   `call_mcp_tool`: 直接调用 MCP 工具并返回结果，不生成报告。适用于快速测试单个工具功能。
-   `batch_test_tools`: 批量测试多个 MCP 工具，支持为每个工具指定不同的测试参数。
-   `benchmark_single_tool`: 对单个 MCP 工具进行性能基准测试。
-   `test_negative_cases`: 测试 MCP 工具的负面用例，验证错误处理能力。

## 如何配置到 Cursor 中

要将此 MCP Tester 服务配置到 Cursor 中，您可以将以下 JSON 片段添加到您的 `c:\Users\Jimmy\.cursor\mcp.json` 文件中 (如果该文件不存在，请创建它)。

**请确保在添加前，`c:\Users\Jimmy\.cursor\mcp.json` 是一个有效的 JSON 对象。**

```json
{
  // ... 其他现有配置 ...
  "mcp-tester": {
    "command": "npx",
    "args": [
      "-y",
      "@zb2947244682/mcp-tester"
    ]
  }
}
```

**注意**: 将 `@yourusername/mcp-tester` 替换为您实际发布到 npm 的包名。

## 如何运行

在项目根目录下运行：

```bash
node index.js
```

或者，如果通过 npm 发布后：

```bash
npx @zb2947244682/mcp-tester
```
