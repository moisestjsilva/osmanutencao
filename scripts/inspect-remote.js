import { Client } from 'ssh2';

const conn = new Client();
conn.on('ready', () => {
  conn.exec(`
    echo "=== USER INFO ==="
    id
    echo "=== HOME os_rufato ==="
    ls -la /home/os_rufato
    echo "=== HTDOCS ==="
    ls -la /home/os_rufato/htdocs/os.moveisrufato.com.br
    echo "=== PATH & ENVIRONMENT ==="
    echo $PATH
    echo "=== BUSCANDO NODE ==="
    which node 2>/dev/null || echo "which node failed"
    find / -name "node" -type f -perm /111 2>/dev/null | head -n 10
    echo "=== NGINX VHOST CONFIG ==="
    cat /etc/nginx/sites-enabled/os.moveisrufato.com.br.conf 2>/dev/null || cat /etc/nginx/conf.d/os.moveisrufato.com.br.conf 2>/dev/null || ls -la /etc/nginx/sites-enabled/ 2>/dev/null || echo "sem acesso a nginx conf"
  `, (err, stream) => {
    if (err) throw err;
    stream.on('data', d => process.stdout.write(d));
    stream.stderr.on('data', d => process.stderr.write(d));
    stream.on('close', () => conn.end());
  });
}).connect({ host: '186.225.65.17', port: 22, username: 'osrufato', password: 'ImDs5nSJ8BmeFOTjS4L2' });
