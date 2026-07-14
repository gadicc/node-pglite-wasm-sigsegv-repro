FROM node:26-bookworm

WORKDIR /repro

COPY package.json package-lock.json ./
RUN npm ci

COPY child.mjs repro.mjs ./

CMD ["node", "repro.mjs", "16", "50"]
