# 发布到 npm (作为 npx 可执行包)

要将此 MCP 服务发布到 npm，以便可以使用 `npx @zb2947244682/mcp-calculator` 命令，请确保已执行以下步骤：

1.  **更新 `package.json`**:
    *   `"name"` 字段应设置为您 npm 用户作用域下的唯一包名，例如：`"@zb2947244682/mcp-calculator"`。
    *   `"type": "module"` 字段应存在，因为 `index.js` 使用 ES Modules 语法。
    *   `"bin"` 字段应指向 `index.js`，例如：`"mcp-calculator": "./index.js"`。
    *   `"author"`、`"repository"`、`"homepage"` 和 `"bugs"` 字段已在之前的步骤中根据您的用户名更新。

2.  **在 `index.js` 顶部添加 Shebang 行**:
    *   确保 `index.js` 文件的第一行是 `#!/usr/bin/env node`，这将使其在作为可执行脚本时通过 Node.js 运行。

3.  **登录 npm (如果您还没有)**:
    在终端中运行 `npm login`，并按照提示登录您的 npm 账号。如果您的 npm 配置指向内部注册表（如 `npm.edu-sjtu.cn`），但您想发布到公共 npm 注册表（`registry.npmjs.org`），您需要指定注册表：
    ```bash
npm login --registry=https://registry.npmjs.org/
    ```

4.  **发布包**:
    在 `4.MCP/4.Calculator` 目录下运行发布命令。对于作用域包，您需要指定 `--access public`：
    ```bash
npm publish --access public --registry=https://registry.npmjs.org/
    ```

# 通过 npx 使用 MCP 服务

发布成功后，您现在可以从任何目录通过 `npx` 调用您的 MCP 计算器服务：

```bash
npx @zb2947244682/mcp-calculator
```

这将在本地运行您的 MCP 服务，并将其输出到标准输出，以便 MCP 客户端（如 Cursor）可以与其交互。
