module.exports = {
  apps: [
    {
      name: "huawei-iotda-web",
      script: "server.js",
      cwd: process.cwd(),
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "300M",
      restart_delay: 2000,
      env: {
        NODE_ENV: "production",
        PORT: "3000"
      }
    }
  ]
};
