# Scholarship Forge

面向大学申请的 AI 文书平台 MVP。学生可上传材料或粘贴背景信息，生成英文 SOP、Personal Statement 和 Resume/CV。API Key 只保存在后端环境变量中，访问者不会看到。

## 本地运行

```bash
cp .env.example .env
node server.js
```

打开 `http://localhost:3000`。

如果没有配置 `DASHSCOPE_API_KEY`，系统会返回本地 demo draft，方便先看完整流程。配置后会调用阿里云百炼 OpenAI 兼容接口。

## 环境变量

- `DASHSCOPE_API_KEY`：你的阿里云百炼 API Key。
- `DASHSCOPE_MODEL`：默认 `qwen-plus`。
- `DASHSCOPE_BASE_URL`：默认 `https://dashscope.aliyuncs.com/compatible-mode/v1`。
- `SUPABASE_URL`：Supabase 项目 URL。
- `SUPABASE_SERVICE_ROLE_KEY`：Supabase service role key，只能放在服务端。
- `SUPABASE_TABLE`：默认 `student_generations`。
- `PORT`：默认 `3000`。

## Supabase

在 Supabase SQL Editor 中执行 `supabase/schema.sql`。服务端会通过 REST API 保存每个匿名访客最近 5 条生成内容。

未配置 Supabase 时，系统会退回到本地 `.data/history.json`，方便本地测试；正式部署建议配置 Supabase。

## 部署成网页链接

这个项目是零依赖 Node 应用，可部署到支持 Node 20+ 的平台或服务器。推荐 Render、Railway、Zeabur 或自己的云服务器。

### Render

1. 把项目上传到 GitHub。
2. 在 Render 新建 Web Service，选择这个仓库。
3. Render 会读取 `render.yaml`。
4. 在环境变量里填写：
   - `DASHSCOPE_API_KEY`
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
5. 部署完成后，Render 会给出一个公网 URL，学生直接打开即可使用。

### Railway

1. 把项目上传到 GitHub。
2. 在 Railway 新建项目并选择仓库。
3. Railway 会读取 `railway.json`。
4. 添加 `.env.example` 中的环境变量。
5. 部署完成后生成公开域名。

### 云服务器

在服务器上安装 Node 20+，上传项目并设置环境变量后运行：

```bash
node server.js
```

再用 Nginx、宝塔、1Panel 或平台自带域名功能绑定公网域名。
