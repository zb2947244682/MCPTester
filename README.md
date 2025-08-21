# MCP Tester - MCP工具测试器

一个强大的MCP（Model Context Protocol）工具测试器，可以帮助你测试和验证MCP服务器的功能、性能和兼容性。

## ✨ 主要改进

**现在MCPTester提供真实的测试功能！**

- 🔍 **真实的MCP协议通信** - 不再是模拟数据，而是真实连接和测试MCP服务器
- 📊 **详细的请求/响应日志** - 查看每个测试的完整请求参数和响应结果
- ⚡ **真实的性能测试** - 测量实际的响应时间和并发性能
- 🧪 **完整的工具验证** - 验证工具的schema并实际调用测试

## 🚀 快速开始

### 安装依赖

```bash
npm install
```

### 运行MCPTester

```bash
node index.js
```

## 🛠️ 可用工具

### 1. test_mcp_server
测试指定的MCP服务器的基本功能

**示例输出：**
- 显示服务器启动状态
- 列出所有可用工具
- 测试第一个工具并显示请求/响应

### 2. validate_mcp_tools
深度验证MCP工具的schema和功能

**特点：**
- ✅ 验证每个工具的schema结构
- ✅ 实际调用工具进行功能测试
- ✅ 显示完整的请求参数（JSON格式）
- ✅ 显示实际的响应结果（JSON格式）
- ✅ 记录执行时间和错误信息

### 3. benchmark_mcp_performance
对MCP服务器进行性能基准测试

**测试指标：**
- 平均响应时间、最小/最大响应时间
- P50、P95延迟分位数
- 并发请求性能
- 成功率统计

### 4. generate_mcp_test_report
生成详细的Markdown格式测试报告

**报告内容：**
- 工具列表和详细信息
- 实际的测试示例（包含请求和响应）
- 性能指标
- 优化建议

### 5. mock_mcp_client
模拟MCP客户端发送自定义请求

**支持的请求类型：**
- initialize - 初始化连接
- list_tools - 获取工具列表
- call_tool - 调用特定工具
- ping - 测试连接

## 📝 使用示例

### 测试示例服务器

首先，运行示例MCP服务器：
```bash
node test-example.js
```

然后在另一个终端中，你可以：

1. **基本测试：**
```json
{
  "tool": "test_mcp_server",
  "arguments": {
    "server_command": "node test-example.js",
    "timeout": 30
  }
}
```

2. **验证特定工具：**
```json
{
  "tool": "validate_mcp_tools",
  "arguments": {
    "server_command": "node test-example.js",
    "tool_name": "add"
  }
}
```

3. **性能测试：**
```json
{
  "tool": "benchmark_mcp_performance",
  "arguments": {
    "server_command": "node test-example.js",
    "iterations": 20,
    "concurrent_requests": 5
  }
}
```

## 🔍 查看真实的测试结果

现在当你运行工具验证时，你会看到：

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

这样你就能确认：
- ✅ 工具确实被调用了
- ✅ 使用了什么参数
- ✅ 得到了什么响应
- ✅ 响应格式是否正确

## 🔧 环境变量

你可以设置默认的目标MCP服务器：

```bash
export TARGET_MCP_SERVER="node /path/to/your/mcp-server.js"
```

## 💡 提示

1. **Windows用户**：路径会自动处理，支持反斜杠
2. **调试信息**：stderr输出会显示为"[MCP Server Debug]"
3. **超时处理**：默认30秒超时，可通过参数调整
4. **并发测试**：性能测试支持并发请求测试

## 📄 许可证

MIT

## 🤝 贡献

欢迎提交Issue和Pull Request！