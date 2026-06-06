module.exports = {
  apps: [
    {
      name: 'tank-arena',
      script: 'dist/server/index.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
        PORT: 3001,
        ADMIN_PASSWORD: ''
      }
    }
  ]
};
