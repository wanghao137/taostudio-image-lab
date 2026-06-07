const REPO = 'CookSleep/gpt_image_playground'
const GITHUB_API_URL = `https://api.github.com/repos/${REPO}/releases/latest`

function writeNoUpdate(response) {
  response.statusCode = 204
  response.setHeader('Cache-Control', 'public, s-maxage=900, stale-while-revalidate=3600')
  response.end()
}

export default async function handler(request, response) {
  if (request.method !== 'GET') {
    response.statusCode = 405
    response.setHeader('Allow', 'GET')
    response.end()
    return
  }

  try {
    const upstream = await fetch(GITHUB_API_URL, {
      headers: {
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'taostudio-image-lab-version-check',
      },
    })

    if (!upstream.ok) {
      writeNoUpdate(response)
      return
    }

    const payload = await upstream.json()
    response.statusCode = 200
    response.setHeader('Content-Type', 'application/json; charset=utf-8')
    response.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400')
    response.end(JSON.stringify({
      tag_name: typeof payload.tag_name === 'string' ? payload.tag_name : '',
      html_url: typeof payload.html_url === 'string' ? payload.html_url : `https://github.com/${REPO}/releases/latest`,
    }))
  } catch {
    writeNoUpdate(response)
  }
}
