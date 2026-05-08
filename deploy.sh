#!/usr/bin/env bash
# MockForge 部署脚本 — 自动适配 docker compose v1/v2，服务器免装 plugin
set -euo pipefail

cd "$(dirname "$0")"

# 自动选 compose 命令
if docker compose version >/dev/null 2>&1; then
  DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  DC="docker-compose"
else
  echo "Error: neither 'docker compose' nor 'docker-compose' found in PATH" >&2
  exit 1
fi

# .env 校验
if [[ ! -f .env ]]; then
  echo "Error: .env not found in $(pwd). Create it first (see README/部署文档)." >&2
  exit 1
fi

# 读 HOST_PORT(默认 9020,与 docker-compose.yml 同步)
HOST_PORT=$(grep -E '^HOST_PORT=' .env 2>/dev/null | tail -1 | cut -d= -f2- | tr -d ' "'"'")
HOST_PORT=${HOST_PORT:-9020}

# 范围提示(阿里云此服务器开放 9000-9099,超出范围只是 warning,不阻断)
if ! [[ "$HOST_PORT" =~ ^[0-9]+$ ]] || (( HOST_PORT < 1 || HOST_PORT > 65535 )); then
  echo "Error: HOST_PORT='$HOST_PORT' 不是合法端口(1-65535)" >&2
  exit 1
fi
if (( HOST_PORT < 9000 || HOST_PORT > 9099 )); then
  echo "Warning: HOST_PORT=$HOST_PORT 不在阿里云此服务器开放范围 9000-9099,外部可能访问不到" >&2
fi

cmd="${1:-help}"
shift || true

# 项目名(docker-compose 默认用目录名 lowercase)
PROJECT="$(basename "$PWD" | tr '[:upper:]' '[:lower:]')"

# 清理本项目残留的容器(保留 volumes / images / networks)
# 用途 1:Docker 23+ 上 docker-compose v1 recreate 时撞 ContainerConfig bug 的根治
# 用途 2:手动恢复"启动失败留下死容器"等异常状态
do_clean() {
  local containers
  containers=$(docker ps -aq --filter "label=com.docker.compose.project=${PROJECT}" 2>/dev/null || true)
  if [[ -n "$containers" ]]; then
    echo "==> 清理本项目残留容器: $containers"
    docker rm -f $containers >/dev/null
  else
    echo "==> 无残留容器"
  fi
}

# 抽出端口检测 + 自动清理 + up 流程,deploy 子命令也用
do_up() {
  if command -v ss >/dev/null 2>&1 && ss -lnt 2>/dev/null | awk '{print $4}' | grep -qE ":${HOST_PORT}\$"; then
    echo "Error: 宿主机端口 $HOST_PORT 已被占用,改 .env 的 HOST_PORT 后再试" >&2
    ss -lntp 2>/dev/null | grep ":${HOST_PORT} " || true
    return 1
  fi
  # 启动前自动清理(避免 v1 + Docker 23+ recreate 路径的 ContainerConfig bug)
  do_clean
  echo "==> 启动服务,宿主机映射端口: $HOST_PORT(容器内 3000)"
  $DC up -d "$@"
  sleep 2
  $DC ps
  echo "==> 健康检查: curl http://localhost:$HOST_PORT/api/health"
}

case "$cmd" in
  build)
    $DC build "$@"
    ;;
  up)
    do_up "$@"
    ;;
  down)
    $DC down "$@"
    ;;
  clean)
    do_clean
    ;;
  restart)
    $DC restart "$@"
    ;;
  logs)
    $DC logs -f --tail=200 "$@"
    ;;
  ps|status)
    $DC ps
    ;;
  deploy)
    # 一键升级:git pull + 构建 + 启动(走端口检测)
    git pull
    $DC build
    do_up
    ;;
  shell|sh)
    $DC exec mockforge sh
    ;;
  backup)
    ts=$(date +%Y%m%d-%H%M%S)
    mkdir -p backups
    $DC exec -T mockforge sh -c 'cp data/mockforge.db /tmp/_backup.db'
    docker cp "$($DC ps -q mockforge):/tmp/_backup.db" "backups/mockforge-${ts}.db"
    echo "Backup written: backups/mockforge-${ts}.db"
    ;;
  health)
    curl -fsS "http://localhost:${HOST_PORT}/api/health" && echo
    ;;
  *)
    cat <<EOF
MockForge 部署脚本(自动适配 docker compose v1/v2)

用法: ./deploy.sh <命令>

命令:
  build       构建镜像
  up          启动服务(后台,自动 clean + 检测端口)
  down        停止并移除容器(数据卷保留)
  clean       强删本项目残留容器(volumes/images 不动)
  restart     重启服务
  logs        实时日志(Ctrl+C 退出)
  ps          容器状态
  deploy      一键升级: git pull + build + up
  shell       进入容器 shell
  backup      备份 SQLite 到 ./backups/
  health      调用 /api/health 检查

当前 docker compose 命令: $DC
当前宿主机端口(HOST_PORT): $HOST_PORT  (改 .env 中 HOST_PORT 即可,默认 9020)
EOF
    ;;
esac
