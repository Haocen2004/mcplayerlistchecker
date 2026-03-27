# --- 第一阶段：构建阶段 (Builder) ---
FROM node:18-alpine AS builder

WORKDIR /app

# 1. 安装编译原生模块所需的系统依赖
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./

# 2. 安装所有依赖（包含 devDependencies，用于编译 TS）
RUN npm ci

COPY . .

# 3. 编译 TypeScript
RUN npx tsc

# 4. 关键点：清理并只保留生产环境依赖
# 先删除所有 node_modules，然后只安装生产依赖，这样可以确保 native modules 已经编译好
RUN rm -rf node_modules && npm ci --omit=dev


# --- 第二阶段：运行阶段 (Production) ---
FROM node:18-alpine

WORKDIR /app

# 5. 直接从 builder 阶段拷贝已经安装/编译好的 node_modules
COPY --from=builder /app/node_modules ./node_modules
# 拷贝编译后的 js 代码
COPY --from=builder /app/dist ./dist
# 拷贝配置文件
# COPY package.json config.json ./

# 设置环境变量
ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "dist/index.js"]