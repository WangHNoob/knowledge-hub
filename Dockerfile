# 应用镜像：自带 Node 22，绕开服务器上的旧 Node。数据库不在此镜像内（连外部 PostgreSQL）。
FROM node:22-slim

WORKDIR /app

# 先装依赖（含 devDependencies：构建用 tsc/vite，运行用 tsx）。不要设 NODE_ENV=production，否则会漏装 dev 依赖。
COPY package.json package-lock.json* ./
RUN npm ci

# 再拷源码并构建前端到 dist/client（.dockerignore 已排除 data/seed/node_modules 等）
COPY . .
RUN npm run build

ENV HOST=0.0.0.0 \
    PORT=4174 \
    KH_DATA_DIR=/app/data

EXPOSE 4174

# 生产以 tsx 直跑后端；若存在 dist/client 则自动托管 SPA
CMD ["npm", "start"]
