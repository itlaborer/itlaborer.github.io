addEventListener('fetch', event => {
    event.respondWith(handleRequest(event.request))
  })
  
  async function handleRequest(request) {
    const url = new URL(request.url)
    
    // 如果是根路径，返回包含 Docsify 和远程 .md 文件的 HTML 页面
    if (url.pathname === "/") {
      return new Response(await generateDocsifyPage(), {
        headers: { 'Content-Type': 'text/html' }
      })
    }
    
    // 如果请求是远程 Markdown 文件，重定向到相应的文件
    if (url.pathname.endsWith('.md')) {
      const remoteMD = `https://raw.githubusercontent.com/itlaborer/itlaborer.github.io/refs/heads/master${url.pathname}`; // 修改为实际的远程 .md 文件地址
      const response = await fetch(remoteMD)
      const mdContent = await response.text()
      return new Response(mdContent, { headers: { 'Content-Type': 'text/markdown' } })
    }
  
    return new Response('Not Found', { status: 404 })
  }
  
  // 生成 Docsify 页面并嵌入远程 Markdown 文件
  async function generateDocsifyPage() {
    return `
      <!DOCTYPE html>
      <html lang="zh_CN">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Docsify on Cloudflare Worker</title>
        <script src="https://cdn.jsdelivr.net/npm/docsify@4.12.0/lib/docsify.min.js"></script>
  
        <!-- 默认主题 -->
      <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/docsify-themeable@0/dist/css/theme-simple-dark.css">
      </head>
      <body>
        <div id="app"></div>
        <script>
          window.$docsify = {
            name: 'OPS笔记',
            repo: 'https://itlaborer.github.io/',  // 如果有 GitHub 仓库可以提供链接
            loadSidebar: true,  // 启用侧边栏
            loadNavbar: true,
            // 封面支持，默认加载的是项目根目录下的_coverpage.md文件
            coverpage: true,
            // 最大支持渲染的标题层级
            subMaxLevel: 4,  // 子目录最大显示层级
            
          }
        </script>
        <!-- docsify的js依赖 -->
        <script src="//cdn.jsdelivr.net/npm/docsify/lib/docsify.min.js"></script>
        <!-- emoji表情支持 -->
        <script src="//cdn.jsdelivr.net/npm/docsify/lib/plugins/emoji.min.js"></script>
        <!-- 图片放大缩小支持 -->
        <script src="//cdn.jsdelivr.net/npm/docsify/lib/plugins/zoom-image.min.js"></script>
        <!-- 搜索功能支持 -->
        <script src="//cdn.jsdelivr.net/npm/docsify/lib/plugins/search.min.js"></script>
      </body>
      </html>
    `
  }