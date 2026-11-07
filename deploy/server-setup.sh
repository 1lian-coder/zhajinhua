#!/usr/bin/env bash
# 炸金花 · 阿里云轻量服务器一键安装
# 用法：在服务器网页终端里执行
#   bash server-setup.sh <创建口令>
# 例：bash server-setup.sh 7749
# 不传口令则不启用创建限制。

set -euo pipefail

PIN="${1:-}"
APP_DIR="/opt/zhajinhua"
SERVICE="zhajinhua"
PORT="8080"

echo ""
echo "  ======================================"
echo "   炸金花 · 服务器安装开始"
echo "  ======================================"
echo ""

# ------------------------------------------------ 1) 基础工具
if command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y curl ca-certificates git
else
  echo "[错误] 这个脚本只支持 Ubuntu/Debian（apt 系）。" >&2
  exit 1
fi

# ------------------------------------------------ 2) Node.js 22 LTS
if ! command -v node >/dev/null 2>&1 || ! node -v | grep -qE 'v(1[8-9]|2[0-9])\.'; then
  echo "[1/6] 安装 Node.js 22 ..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
echo "[1/6] Node.js: $(node -v)"

# ------------------------------------------------ 3) 代码
if [ -d "$APP_DIR/.git" ]; then
  echo "[2/6] 更新代码 ..."
  git -C "$APP_DIR" pull --ff-only || {
    echo "  仓库更新失败（可能有本地改动），用全新克隆兜底 ..."
    rm -rf "$APP_DIR"
    git clone https://github.com/1lian-coder/zhajinhua.git "$APP_DIR"
  }
else
  echo "[2/6] 克隆代码 ..."
  rm -rf "$APP_DIR"
  git clone https://github.com/1lian-coder/zhajinhua.git "$APP_DIR"
fi

# ------------------------------------------------ 4) systemd 常驻服务
echo "[3/6] 配置 systemd 服务（开机自启 + 崩溃自动重启）..."
mkdir -p "$APP_DIR/data"
cat > "/etc/systemd/system/${SERVICE}.service" <<EOF
[Unit]
Description=Zhajinhua card game server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
Environment=PORT=$PORT
Environment=HOST=0.0.0.0
${PIN:+Environment=CREATE_PIN=$PIN}
ExecStart=$(command -v node) server.js
Restart=always
RestartSec=3
# 输出落到 journal，用 journalctl -u zhajinhua -f 查看

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null
systemctl restart "$SERVICE"

# ------------------------------------------------ 5) 系统防火墙
echo "[4/6] 防火墙放行 $PORT 端口 ..."
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow "$PORT/tcp" >/dev/null
  echo "  ufw 已放行 $PORT/tcp"
else
  echo "  系统防火墙未启用，无需处理"
fi
echo "  [提醒] 还需在阿里云控制台 → 防火墙/安全组 里放行 TCP $PORT，否则外网访问不到！"

# ------------------------------------------------ 6) 验证
sleep 2
echo "[5/6] 健康检查 ..."
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS "http://127.0.0.1:$PORT/api/health" >/tmp/zjh-health.json 2>/dev/null; then
    break
  fi
  sleep 1
done
if [ -s /tmp/zjh-health.json ]; then
  echo "  $(cat /tmp/zjh-health.json)"
else
  echo "  [失败] 服务没起来，看日志：journalctl -u $SERVICE -n 50 --no-pager" >&2
  exit 1
fi

# 公网 IP：优先阿里云元数据服务（不依赖外网），其次常见 API
PUB_IP=""
try_ip() { [ -n "$PUB_IP" ] && return 0; PUB_IP="$(eval "$1" 2>/dev/null | tr -d '[:space:]')"; }
try_ip 'curl -fsS --max-time 3 http://100.100.100.200/latest/meta-data/eipv4'
try_ip 'curl -fsS --max-time 5 https://ipinfo.io/ip'
try_ip 'curl -fsS --max-time 5 https://api.ipify.org'
try_ip 'curl -fsS --max-time 5 https://ifconfig.me/ip'

echo ""
echo "[6/6] 完成！"
echo "  ======================================"
if [ -n "$PUB_IP" ]; then
  echo "   游戏地址（发给朋友，永久固定）："
  echo ""
  echo "     http://$PUB_IP:$PORT"
  echo ""
  [ -n "$PIN" ] && echo "   创建口令：$PIN"
  echo "   服务状态：systemctl status $SERVICE"
  echo "   实时日志：journalctl -u $SERVICE -f"
  echo "  ======================================"
else
  echo "   安装完成。公网 IP 到阿里云控制台看，地址是 http://<公网IP>:$PORT"
fi
echo ""
