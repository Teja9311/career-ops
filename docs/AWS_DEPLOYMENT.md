# Run CareerOps continuously on AWS

This deployment runs CareerOps in one Docker container on an EC2 instance. It
polls Slack every five minutes, runs market discovery hourly, stores state on
the EC2 disk, and restarts after reboots.

## 1. Create the Slack app

Create an app at `api.slack.com/apps`, install it to the workspace, and add these
bot token scopes:

- `channels:history`
- `channels:read`
- `chat:write`
- `files:write`

Invite the bot to `#all-job`. Copy its `xoxb-...` Bot User OAuth Token. CareerOps
filters commands to the configured authorized Slack user ID.

## 2. Create the EC2 host

In AWS, launch an Ubuntu 24.04 LTS **x86_64** instance:

- Start with `t3.large` (2 vCPU, 8 GiB RAM).
- Use at least 40 GiB gp3 storage.
- Allow inbound SSH (port 22) from your own IP only.
- No public application port is required.
- Attach an Elastic IP if you want its public address to stay stable.

Connect:

```bash
ssh -i /path/to/key.pem ubuntu@EC2_PUBLIC_IP
```

Install Docker:

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl git
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ubuntu
exit
```

Reconnect so the Docker group takes effect.

## 3. Put the repository on EC2

If you have reviewed and pushed the deployment code to your private fork:

```bash
git clone https://github.com/Teja9311/career-ops.git
cd career-ops
```

If you do not want to push anything, copy the complete local checkout directly
from the Mac instead:

```bash
rsync -av --delete \
  --exclude='.git/' --exclude='node_modules/' --exclude='deploy/.env.aws' \
  /Users/rajiashareenshaik/Documents/career-ops/ \
  ubuntu@EC2_PUBLIC_IP:~/career-ops/
```

When you cloned the fork on EC2, the personal files are still absent because
they are intentionally Git-ignored. Transfer them securely from the Mac:

```bash
rsync -av \
  --include='cv.md' \
  --include='tejaagent.md' \
  --include='portals.yml' \
  --include='config/' --include='config/profile.yml' \
  --include='modes/' --include='modes/_profile.md' --include='modes/_custom.md' \
  --include='data/' --include='data/***' \
  --exclude='*' \
  /Users/rajiashareenshaik/Documents/career-ops/ \
  ubuntu@EC2_PUBLIC_IP:~/career-ops/
```

## 4. Add runtime secrets

On EC2:

```bash
cd ~/career-ops/deploy
cp .env.aws.example .env.aws
nano .env.aws
chmod 600 .env.aws
```

Set `OPENAI_API_KEY` and `SLACK_BOT_TOKEN`. The channel and authorized user IDs
are already populated for the current `#all-job` workflow.

For stronger secret management, store both values in AWS Secrets Manager and
generate `.env.aws` during boot with an instance role. Do not put secrets in the
AMI, Git, Docker image, or shell history.

## 5. Build and start

```bash
cd ~/career-ops
docker compose -f deploy/compose.aws.yml build
docker compose -f deploy/compose.aws.yml up -d
docker compose -f deploy/compose.aws.yml logs -f --tail=100
```

The container uses `restart: unless-stopped`, so it returns after an EC2 or
Docker restart.

## 6. Test Slack

In `#all-job`, send a normal message or `DETAILS <CareerOps ID>`. Within five
minutes the worker should answer in the corresponding thread. Then verify an
hourly scan:

```bash
docker compose -f deploy/compose.aws.yml logs --since=70m
```

## Operations

Update after making and pushing reviewed code changes:

```bash
cd ~/career-ops
git pull --ff-only
docker compose -f deploy/compose.aws.yml up -d --build
```

Back up `data/`, `output/`, `reports/`, `jds/`, `cv.md`, `config/`, `modes/`,
and `portals.yml`. An EBS snapshot is the simplest full-host backup.

Check health:

```bash
docker compose -f deploy/compose.aws.yml ps
docker compose -f deploy/compose.aws.yml logs --tail=200
```

Stop:

```bash
docker compose -f deploy/compose.aws.yml down
```

## Important limitation

The AWS worker can discover jobs, converse in Slack, prepare applications, and
upload tailored PDFs. Sites that require an interactive login, MFA, CAPTCHA, or
human attestation may still require a desktop handoff. The approval gate remains
mandatory: `APPLY` prepares; only a role-specific `CONFIRM SUBMIT` after an
unchanged final review authorizes submission.
