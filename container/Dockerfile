FROM oven/bun:1.2.22-debian

ARG OPENCODE_VERSION=1.15.13
ARG CHROME_DEVTOOLS_MCP_VERSION=1.1.1
ARG NODE_MAJOR=22

ENV BUN_INSTALL=/usr/local
ENV PATH=/opt/openralph/bin:/usr/local/bin:${PATH}

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates curl git gnupg \
  && mkdir -p /etc/apt/keyrings \
  && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
  && printf 'deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_%s.x nodistro main\n' "${NODE_MAJOR}" > /etc/apt/sources.list.d/nodesource.list \
  && curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /etc/apt/keyrings/google-linux.gpg \
  && printf 'deb [arch=amd64 signed-by=/etc/apt/keyrings/google-linux.gpg] https://dl.google.com/linux/chrome/deb/ stable main\n' > /etc/apt/sources.list.d/google-chrome.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends \
    build-essential \
    fonts-dejavu \
    fonts-liberation \
    fonts-noto-color-emoji \
    fonts-noto-core \
    google-chrome-stable \
    nodejs \
    pkg-config \
    python3 \
    python3-pip \
    python3-venv \
    ripgrep \
  && corepack enable \
  && npm install --global chrome-devtools-mcp@${CHROME_DEVTOOLS_MCP_VERSION} \
  && npm cache clean --force \
  && rm -rf /var/lib/apt/lists/*

RUN bun install --global opencode-ai@${OPENCODE_VERSION}

WORKDIR /opt/openralph

COPY package.json bun.lock tsconfig.json ./
COPY src ./src
COPY container/bin ./bin
COPY bin/openralph ./bin/openralph
COPY AGENTS.md README.md PROMPT_build.md PROMPT_plan.md ./

RUN bun install --production --frozen-lockfile

RUN chmod +x /opt/openralph/bin/chrome-devtools-mcp-wrapper /opt/openralph/bin/openralph

RUN useradd --create-home --shell /bin/bash opencode \
  && mkdir -p /home/opencode/.local/share/opencode /workspace \
  && chmod -R 0777 /home/opencode /workspace

ENV HOME=/home/opencode

USER opencode

WORKDIR /workspace
