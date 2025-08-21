# MCPTester 新功能文档

## 📋 新增功能概览

根据您的建议，我已为 MCPTester 添加了以下新功能：

### 1. 🎯 批量功能测试 (`batch_test_tools`)

支持一次性测试多个工具，每个工具可以有不同的测试参数。

**使用示例：**
```json
{
  "server_command": "node D:/Path/To/calculator.js",
  "test_cases": [
    {
      "tool_name": "add",
      "arguments": {"a": 10, "b": 20},
      "description": "测试加法：10 + 20"
    },
    {
      "tool_name": "subtract",
      "arguments": {"a": 100, "b": 50},
      "description": "测试减法：100 - 50"
    },
    {
      "tool_name": "multiply",
      "arguments": {"a": 5, "b": 6},
      "description": "测试乘法：5 × 6"
    },
    {
      "tool_name": "divide",
      "arguments": {"a": 100, "b": 4},
      "description": "测试除法：100 ÷ 4"
    }
  ],
  "parallel": true,  // 并行执行
  "stop_on_error": false  // 遇到错误继续执行
}
```

**特点：**
- 支持串行或并行执行
- 可配置是否在错误时停止
- 详细的性能统计和结果报告
- 每个测试用例可添加描述

### 2. ⚡ 单工具性能基准测试 (`benchmark_single_tool`)

专门针对单个工具进行深度性能测试。

**使用示例：**
```json
{
  "server_command": "node D:/Path/To/calculator.js",
  "tool_name": "multiply",
  "tool_arguments": {"a": 10, "b": 20},
  "iterations": 1000,  // 测试1000次
  "concurrent_requests": 10,  // 10个并发请求
  "warmup_iterations": 50  // 50次预热
}
```

**特点：**
- 预热阶段确保准确性
- 支持并发测试
- 详细的统计数据（P50、P90、P95、P99）
- 标准差分析响应时间稳定性
- 吞吐量计算

### 3. ❌ 负面测试用例 (`test_negative_cases`)

测试工具对无效输入或边界情况的处理能力。

**使用示例：**
```json
{
  "server_command": "node D:/Path/To/calculator.js",
  "negative_cases": [
    {
      "tool_name": "divide",
      "arguments": {"a": 10, "b": 0},
      "expected_error": "除数不能为零",
      "description": "测试除零错误"
    },
    {
      "tool_name": "sqrt",
      "arguments": {"number": -1},
      "expected_error": ".*负数.*平方根.*",
      "description": "测试负数平方根"
    },
    {
      "tool_name": "add",
      "arguments": {"a": "string", "b": 10},
      "expected_error": "类型错误",
      "description": "测试类型错误"
    }
  ],
  "strict_mode": false  // 使用宽松匹配（支持正则表达式）
}
```

**特点：**
- 支持严格匹配或宽松匹配
- 正则表达式支持
- 验证错误处理机制
- 详细的测试结果报告

### 4. 📝 增强的报告生成 (`generate_mcp_test_report`)

现在支持更多自定义选项。

**使用示例：**
```json
{
  "server_command": "node D:/Path/To/calculator.js",
  "output_format": "json",  // 输出为JSON格式
  "tools_filter": ["add", "multiply"],  // 只测试指定工具
  "include_performance": true,  // 包含性能测试
  "performance_iterations": 100,  // 性能测试迭代次数
  "test_tools": true,  // 实际测试工具
  "include_examples": true  // 包含使用示例
}
```

**新增选项：**
- **output_format**: 支持 markdown、json、html 三种格式
- **tools_filter**: 只测试和报告特定工具
- **include_performance**: 是否包含性能测试数据
- **test_tools**: 是否实际测试（false则只生成静态报告）

## 🔧 路径格式支持

所有工具的 `server_command` 参数现在都明确支持以下路径格式：

- **Windows 反斜杠**：`D:\Path\To\script.js`
- **Windows 正斜杠**：`D:/Path/To/script.js`
- **Unix 路径**：`/path/to/script.js`
- **带空格路径**：`"D:\My Path\script.js"`
- **带执行器**：`node D:\Path\script.js` 或 `python script.py`
- **相对路径**：`./script.js` 或 `../folder/script.js`

## 📊 使用场景示例

### 场景1：回归测试
使用 `batch_test_tools` 一次性运行所有测试用例：
```json
{
  "server_command": "node calculator.js",
  "test_cases": [/* 所有测试用例 */],
  "parallel": true,
  "stop_on_error": false
}
```

### 场景2：性能优化
使用 `benchmark_single_tool` 找出性能瓶颈：
```json
{
  "server_command": "node api-server.js",
  "tool_name": "process_data",
  "tool_arguments": {"size": "large"},
  "iterations": 1000,
  "concurrent_requests": 50
}
```

### 场景3：健壮性测试
使用 `test_negative_cases` 验证错误处理：
```json
{
  "server_command": "node validator.js",
  "negative_cases": [/* 各种无效输入 */],
  "strict_mode": false
}
```

### 场景4：自动化报告
使用增强的 `generate_mcp_test_report` 生成定制报告：
```json
{
  "server_command": "node my-tool.js",
  "output_format": "json",
  "tools_filter": ["critical_tool_1", "critical_tool_2"],
  "include_performance": true
}
```

## 💡 最佳实践

1. **批量测试时**：
   - 相关测试用例使用串行执行
   - 独立测试用例使用并行执行以提高效率

2. **性能测试时**：
   - 先进行小规模测试（100次迭代）
   - 根据结果调整并发数和迭代次数
   - 使用预热确保测试准确性

3. **负面测试时**：
   - 优先使用宽松匹配模式
   - 使用正则表达式处理动态错误消息
   - 为每个测试用例添加清晰的描述

4. **生成报告时**：
   - JSON格式适合自动化处理
   - Markdown格式适合人工阅读
   - HTML格式适合分享和展示

## 🚀 快速开始

1. 确保您的 MCP 工具正常运行
2. 选择合适的测试工具
3. 准备测试参数
4. 运行测试并查看报告

所有新功能都已集成到 MCPTester 中，可以立即使用！