FROM oven/bun:1
WORKDIR /app
COPY package.json bun.lock ./
COPY paperday ./paperday
RUN bun install --frozen-lockfile
EXPOSE 3099
CMD ["bun", "run", "paperday/src/index.ts"]
