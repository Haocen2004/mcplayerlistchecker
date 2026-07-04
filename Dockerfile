# --- 第一阶段：构建阶段 (Builder) ---
FROM node:22-alpine AS builder

WORKDIR /app

# 1. 安装编译原生模块所需的系统依赖
RUN apk add --no-cache python3 make g++

RUN corepack enable && corepack prepare pnpm@10.12.1 --activate

COPY package.json pnpm-lock.yaml ./

# 2. 安装所有依赖（包含 devDependencies，用于编译 TS）
RUN pnpm install --frozen-lockfile

COPY . .

# 3. 编译 TypeScript
RUN pnpm exec tsc

# 4. 关键点：清理并只保留生产环境依赖
# 保留 pnpm 安装出的生产依赖，避免 npm lock 和 pnpm lock 漂移
RUN pnpm prune --prod


# --- 第二阶段：运行阶段 (Production) ---
FROM node:22-alpine

WORKDIR /app

# 5. 直接从 builder 阶段拷贝已经安装/编译好的 node_modules
COPY --from=builder /app/node_modules ./node_modules
# 拷贝编译后的 js 代码
COPY --from=builder /app/dist ./dist
COPY package.json ./
# 拷贝配置文件
# COPY package.json config.json ./

# 设置环境变量
ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "dist/index.js"]
