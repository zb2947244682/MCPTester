# MCPTester 测试命令示例

## 准备工作

1. 首先安装依赖：
```bash
npm install
```

2. 在一个终端启动测试服务器：
```bash
node test-example.js
```

3. 在另一个终端启动MCPTester：
```bash
node index.js
```

## 测试命令示例

### 1. 测试MCP服务器基本功能

发送以下JSON到MCPTester的stdin：

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "test_mcp_server",
    "arguments": {
      "server_command": "node test-example.js",
      "timeout": 10
    }
  }
}
```

**你会看到：**
- 服务器连接状态
- 工具列表
- 示例工具调用的请求参数和响应

### 2. 验证特定工具（add工具）

#### 使用默认参数：
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "validate_mcp_tools",
    "arguments": {
      "server_command": "node test-example.js",
      "tool_name": "add"
    }
  }
}
```

#### 使用自定义参数（新功能！）：
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "validate_mcp_tools",
    "arguments": {
      "server_command": "node test-example.js",
      "tool_name": "add",
      "test_params": {
        "a": 100,
        "b": 200
      }
    }
  }
}
```

**重要：现在会显示真实的测试数据！**

输出示例：
```markdown
#### 📤 请求参数:
```json
{
  "a": 42,
  "b": 42
}
```

#### 📥 实际响应:
```json
{
  "content": [
    {
      "type": "text",
      "text": "计算结果: 42 + 42 = 84"
    }
  ]
}
```
```

### 3. 验证所有工具

#### 使用默认参数：
```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "validate_mcp_tools",
    "arguments": {
      "server_command": "node test-example.js"
    }
  }
}
```

#### 为每个工具指定不同的测试参数：
```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "validate_mcp_tools",
    "arguments": {
      "server_command": "node test-example.js",
      "test_params": {
        "add": {"a": 10, "b": 20},
        "multiply": {"x": 3, "y": 4},
        "greet": {"name": "Tester", "language": "zh"}
      }
    }
  }
}
```

### 4. 性能基准测试

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "tools/call",
  "params": {
    "name": "benchmark_mcp_performance",
    "arguments": {
      "server_command": "node test-example.js",
      "iterations": 10,
      "concurrent_requests": 3
    }
  }
}
```

**会显示：**
- 平均响应时间
- P50、P95延迟
- 并发性能
- 成功率

### 5. 生成测试报告

```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "method": "tools/call",
  "params": {
    "name": "generate_mcp_test_report",
    "arguments": {
      "server_command": "node test-example.js",
      "include_examples": true
    }
  }
}
```

**报告会保存到文件，并包含：**
- 所有工具的详细信息
- 实际的测试示例（带请求和响应）
- 性能指标
- 优化建议

### 6. 模拟客户端请求

#### 标准格式（推荐）：
```json
{
  "jsonrpc": "2.0",
  "id": 6,
  "method": "tools/call",
  "params": {
    "name": "mock_mcp_client",
    "arguments": {
      "server_command": "node test-example.js",
      "request_type": "call_tool",
      "request_data": {
        "name": "greet",
        "arguments": {
          "name": "Alice",
          "language": "zh"
        }
      }
    }
  }
}
```

#### 兼容格式（也支持）：
```json
{
  "jsonrpc": "2.0",
  "id": 6,
  "method": "tools/call",
  "params": {
    "name": "mock_mcp_client",
    "arguments": {
      "server_command": "node test-example.js",
      "request_type": "call_tool",
      "request_data": {
        "toolName": "greet",
        "parameters": {
          "name": "Bob",
          "language": "en"
        }
      }
    }
  }
}
```

**注意**：MCPTester现在支持多种参数格式：
- `name` / `toolName` - 工具名称
- `arguments` / `parameters` / `params` - 工具参数

如果未指定工具名，会提供清晰的错误提示和正确格式示例。

## Windows PowerShell 使用示例

在PowerShell中，你可以这样测试：

```powershell
# 启动测试服务器（在一个PowerShell窗口）
node test-example.js

# 在另一个PowerShell窗口测试
$request = @'
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"validate_mcp_tools","arguments":{"server_command":"node test-example.js","tool_name":"add"}}}
'@

$request | node index.js
```

## 主要改进点

✅ **真实测试**：不再使用模拟数据，而是真实连接MCP服务器  
✅ **详细日志**：显示完整的请求参数和响应结果  
✅ **性能测试**：测量实际的响应时间和并发性能  
✅ **完整验证**：验证schema并实际调用工具  

### 最新改进 (v1.1)

✅ **`validate_mcp_tools` 自定义参数支持**：  
   - 测试单个工具时，直接传递test_params
   - 测试多个工具时，使用工具名作为键的对象格式

✅ **`mock_mcp_client` 更友好的参数格式**：  
   - 清晰的参数格式说明和示例
   - 兼容多种常见格式 (name/toolName, arguments/parameters)
   - 提供有帮助的错误提示

现在你可以确信测试是真实执行的，因为你能看到：
1. 发送了什么请求参数
2. 收到了什么响应结果
3. 执行花了多长时间
4. 是否有错误发生