#!/bin/sh
# Starts a throwaway SSH server in Docker for `npm run test-remote`: Alpine with OpenSSH and Git, user `dev`,
# key-only, on 127.0.0.1:2222. It writes a key and an SSH configuration with `Host gt-test` to /tmp/gt-ssh, so
# ~/.ssh is never read or changed. The server's own ssh client trusts localhost, for the agent forwarding tests.
# Stop it with: docker rm -f git-tree-test-sshd
set -eu
DIR=/tmp/gt-ssh
mkdir -p "$DIR"
cd "$DIR"
[ -f id_test ] || ssh-keygen -q -t ed25519 -N '' -f id_test -C git-tree-test
cat > Dockerfile <<'DOCKERFILE'
FROM alpine:3
RUN apk add --no-cache openssh-server git \
 && ssh-keygen -A \
 && adduser -D -s /bin/sh dev && passwd -u dev >/dev/null 2>&1 || true \
 && mkdir -p /home/dev/.ssh && chmod 700 /home/dev/.ssh
COPY id_test.pub /home/dev/.ssh/authorized_keys
RUN chown -R dev:dev /home/dev/.ssh && chmod 600 /home/dev/.ssh/authorized_keys \
 && printf 'PasswordAuthentication no\nPermitRootLogin no\nAllowUsers dev\n' >> /etc/ssh/sshd_config
# The agent forwarding tests clone on the server from dev@localhost, so the server has an ssh client that trusts itself
RUN apk add --no-cache openssh-client \
 && for key in /etc/ssh/ssh_host_*_key.pub; do printf 'localhost %s\n' "$(cut -d ' ' -f 1,2 "$key")"; done > /home/dev/.ssh/known_hosts \
 && chown dev:dev /home/dev/.ssh/known_hosts
EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
DOCKERFILE
docker build -q -t git-tree-test-sshd . >/dev/null
docker rm -f git-tree-test-sshd >/dev/null 2>&1 || true
docker run -d --name git-tree-test-sshd -p 127.0.0.1:2222:22 git-tree-test-sshd >/dev/null
# A rebuilt image has new host keys, and the client learns them again on its first connection
rm -f known_hosts
cat > ssh_config <<CONFIG
Host gt-test
  HostName 127.0.0.1
  Port 2222
  User dev
  IdentityFile $DIR/id_test
  IdentitiesOnly yes
  StrictHostKeyChecking accept-new
  UserKnownHostsFile $DIR/known_hosts
CONFIG
printf '#!/bin/sh\nexec ssh -F %s/ssh_config "$@"\n' "$DIR" > ssh-wrapper
chmod +x ssh-wrapper
sleep 1
./ssh-wrapper -o BatchMode=yes gt-test true
echo "The test SSH server is running: ssh -F $DIR/ssh_config gt-test"
