FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* yarn.lock* pnpm-lock.yaml* ./

RUN if [ -f package-lock.json ]; then npm ci; \
    elif [ -f yarn.lock ]; then yarn install --frozen-lockfile; \
    elif [ -f pnpm-lock.yaml ]; then corepack enable pnpm && pnpm install --frozen-lockfile; \
    else npm install; fi

COPY . .

ENV NEXT_TELEMETRY_DISABLED=1

RUN npm run build || yarn build || pnpm build

EXPOSE 3000
CMD ["npm","run","dev","--","-H","0.0.0.0"]
