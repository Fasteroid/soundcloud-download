let extensionEnabled = true
let coverArt = false
let trackURL = ""
let userURL = ""
let playlistURL = ""
let playlistLock = false
let clientID = ""
let trackAuth = ""
let authToken = ""

let ignoredTracks = JSON.parse( localStorage.getItem("sc_ignored_tracks") || "{}" );

const parseHTML = async (url) => {
  const html = await fetch(url).then((r) => r.text())
  const json = JSON.parse(html.match(/(\[{)(.*)(?=;)/gm)[0])
  const parsed = json[json.length - 1].data
  return parsed
}

window.parseTrack = async (url) => {
  return parseHTML(url)
}

window.ignoreTrack = async (id, status = true) => {

  try { // did I pass a URL directly?
    let data = await parseHTML(id)
    id = data.id;
  }
  catch(e){}

  id = "_" + id;
  if( status ){
    console.log(`Adding track ${id} to the ignore list`)
    ignoredTracks[id] = true
  }
  else {
    console.log(`Removing track ${id} from the ignore list`)
    delete ignoredTracks[id]
  }

  localStorage.setItem( "sc_ignored_tracks", JSON.stringify(ignoredTracks) )
}

chrome.webRequest.onBeforeRequest.addListener((details) => {
  if (details.url.includes("soundcloud.com/me")) {
    if (!details.requestBody?.raw) return
    const decoder = new TextDecoder("utf-8")
    const json = JSON.parse(decoder.decode(details.requestBody.raw[0].bytes))
    console.log(json.auth_token)
    authToken = json.auth_token
  }
}, {urls: ["https://*.soundcloud.com/*"]}, ["requestBody"])

chrome.webRequest.onSendHeaders.addListener((details) => {
  if (details.url.includes("https://api-v2.soundcloud.com/tracks/")) {
    const url = details.url.split("?")
    const id = url[0].match(/(?<=tracks\/)(.*?)(?=\/)/)?.[0]
    if (!id) return
    const params = new URLSearchParams(`?${url[1]}`)
    clientID = params.get("client_id")
    if (params.has("secret_token")) {
      trackURL = `https://api-v2.soundcloud.com/tracks/soundcloud:tracks:${id}?client_id=${clientID}&secret_token=${params.get("secret_token")}`
    } else {
      trackURL = `https://api-v2.soundcloud.com/tracks/soundcloud:tracks:${id}?client_id=${clientID}`
    } 
  }
  if (details.url.includes("https://api-v2.soundcloud.com/users/soundcloud:users")) {
    const url = details.url.split("?")
    const id = details.url.match(/(?<=soundcloud:users:)(.*?)(?=\/)/)?.[0]
    const params = new URLSearchParams(`?${url[1]}`)
    clientID = params.get("client_id")
    userURL = `https://api-v2.soundcloud.com/users/${id}/tracks?client_id=${clientID}&limit=100`
  }
  if (!playlistLock && details.url.includes("https://api-v2.soundcloud.com/playlists")) {
    const id = details.url.match(/(?<=playlists\/)(.*?)(?=\/|\?)/)?.[0]
    const url = details.url.split("?")
    const params = new URLSearchParams(`?${url[1]}`)
    clientID = params.get("client_id")
    playlistURL = `https://api-v2.soundcloud.com/playlists/${id}?client_id=${clientID}`
    playlistLock = true
  }
  if (details.url.includes("https://api-v2.soundcloud.com/media")) {
    const url = details.url.split("?")
    const params = new URLSearchParams(`?${url[1]}`)
    trackAuth = params.get("track_authorization")
  }
}, {urls: ["https://*.soundcloud.com/*"]})

const clean = (text) => {
  return text?.replace(/[^a-z0-9_-\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\uff00-\uff9f\u4e00-\u9faf\u3400-\u4dbf【】\u200e()\[\]&!#. \|]/gi, "").replace(/~/g, "").replace(/ +/g, " ") ?? "invalid_file"
}

const downloadM3U = async (url) => {
  const m3u = await fetch(url).then((r) => r.text())
  const urls = m3u.match(/(http).*?(?=\s)/gm)
  let crunker = new Crunker.default({sampleRate: 48000})
  const buffers = await crunker.fetchAudio(...urls)
  const merged = await crunker.concatAudio(buffers)
  const output = await crunker.export(merged, "audio/mp3")
  return output.url
}

const getDownloadURL = async (track, album, num) => {

  if( ignoredTracks["_" + track.id] ){ 
    console.warn(`Refusing to download track ${track.title} [${track.id}] as it is on the ignore list!`);
    return ""
  }
  else {
    console.log(`Preparing to download track ${track.title} [${track.id}]`)
  }

  let url = track.media.transcodings.find((t) => t.format.mime_type === "audio/mpeg" && t.format.protocol === "progressive")?.url

  if (!url) {
    url = track.media.transcodings.find((t) => t.format.mime_type === "audio/mpeg" && t.format.protocol === "hls")?.url
    url += url.includes("secret_token") ? `&client_id=${clientID}` : `?client_id=${clientID}`
    if (trackAuth) url += `&track_authorization=${trackAuth}`
    const m3u = await fetch(url, {headers: {"Authorization": `OAuth ${authToken}`}}).then((r) => r.json()).then((m) => m.url)
    return downloadM3U(m3u)
  }

  url += url.includes("secret_token") ? `&client_id=${clientID}` : `?client_id=${clientID}`
  const mp3 = await fetch(url).then((r) => r.json()).then((m) => m.url)
  console.log(`MP3 for ${track.title} received`)

  return fetch(mp3).then((r) => r.arrayBuffer()).then(arrayBuffer => {

    let artwork = track.artwork_url ? track.artwork_url : track.user.avatar_url
    artwork = artwork.replace("-large", "-t500x500")
    return fetch(artwork).then((r) => r.arrayBuffer()).then(imageBuffer => {

      console.log(`Track art for ${track.title} received`)
      const writer = new ID3Writer(arrayBuffer)

      let authors = [track.user.username]
      let title   = track.title
      const results = title.match(/(.+) - (.+)/)

      if( results ){
        if( results[1] != authors[0] ){
          authors.push(results[1]); // add additional author
        }
        console.log("Track '" + title + "' contained an artist's name; removing...")
        title = results[2];
      }

      writer.setFrame("TIT2", title)
          .setFrame("TPE1", authors)
          .setFrame("TLEN", track.duration)
          .setFrame("TYER", new Date(track.created_at).getFullYear())
          .setFrame("TCON", [track.genre])
          .setFrame("COMM", {
            description: "Description",
            text: track.description ?? "",
            language: "eng"
          })
          .setFrame("APIC", {
            type: 3,
            data: imageBuffer,
            description: title,
            useUnicodeEncoding: false
        })
      if (album) {
        writer.setFrame("TALB", `末.${album}.${num}`) // Due to a samsung music bug, in order to get the proper track art to display, no two albums can have the same name.
              .setFrame("TRCK", num)                  // In addition, we use the japanese character for "end" (末) to ensure that these forced albums are always at the bottom of the list.
              .setFrame("TPE2", "Fasteroid")
      }
      writer.addTag()
      return writer.getURL()
    })
  })

}

const getArtURL = (track) => {
  let artwork = track.artwork_url ? track.artwork_url : track.user.avatar_url
  artwork = artwork.replace("-large", "-t500x500")
  return artwork
}

const setIcon = () => {
  if (extensionEnabled === true) {
    if (coverArt) {
      chrome.browserAction.setIcon({path: "assets/icon-pink.png"})
    } else {
      chrome.browserAction.setIcon({path: "assets/icon.png"})
    }
  } else {
    if (coverArt) {
      chrome.browserAction.setIcon({path: "assets/icon-off-pink.png"})
    } else {
      chrome.browserAction.setIcon({path: "assets/icon-off.png"})
    }
  }
}

async function processTrack(track, playlist, num){

  if( track === undefined ){ 
    console.error("wtf track didn't exist???")
    return 
  }

  return fetch(`https://api-v2.soundcloud.com/tracks/soundcloud:tracks:${track.id}?client_id=${clientID}`)
    .then(res => res.json())
    .then(trackData => {
      track = trackData;
      console.log(`Fetched data for ${track.title}`)
      return (coverArt ? getArtURL(track) : getDownloadURL(track, playlist.title, num))
    })
    .then( url => {
      if( url == "" ){ return }
      const cleanTitle = clean(track.title);
      const filename = `${clean(track.title)}.${coverArt ? "jpg" : "mp3"}`.trim()
      chrome.downloads.download({url: url, filename: `${clean(playlist.title)}/${filename}`, conflictAction: "overwrite"}) // thanks for being retarded, Samsung Music!
    })
    .catch(() => {})
  
}

chrome.runtime.onMessage.addListener(async (request, sender, sendResponse) => {
    if (request.message === "download-track") {
      const track = request.track

      const url = coverArt ? getArtURL(track) : await getDownloadURL(track)
      if( url == "" ){ return }
      const filename = `${clean(track.title)}.${coverArt ? "jpg" : "mp3"}`.trim()
      if (url) chrome.downloads.download({url, filename, conflictAction: "overwrite"})
      if (request.href) {
        chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
          chrome.tabs.sendMessage(tabs[0].id, {message: "clear-spinner", href: request.href})
        })
      } else {
        chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
          chrome.tabs.sendMessage(tabs[0].id, {message: "download-stopped", id: request.id})
        })
      }
    }

    if (request.message === "download-user") {
      const trackArray = []
      let user = await fetch(`https://api-v2.soundcloud.com/users/${request.user.id}/tracks?client_id=${clientID}&limit=100`).then(r => r.json())
      trackArray.push(...user.collection)
      while (user.next_href) {
        user = await fetch(`${user.next_href}&client_id=${clientID}`).then(r => r.json())
        trackArray.push(...user.collection)
      }
      for (let i = 0; i < trackArray.length; i++) {
        try {
          const url = coverArt ? getArtURL(trackArray[i]) : await getDownloadURL(trackArray[i])
          const filename = `${clean(trackArray[i].title)}.${coverArt ? "jpg" : "mp3"}`.trim()
          if (url) chrome.downloads.download({url, filename: `${clean(request.user.username)}/${filename}`, conflictAction: "overwrite"})
        } catch (e) {
          console.log(e)
          continue
        }
      }
      chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
        chrome.tabs.sendMessage(tabs[0].id, {message: "download-stopped", id: request.id})
      })
    }

    if (request.message === "download-playlist") {

      const playlist = request.playlist

      const wait = [];
      let n = 0;
      for( track of playlist.tracks ){
        wait[n] = processTrack(track, playlist, n+1);
        n++;
      }
      await Promise.all(wait)

      if (request.href) {
        chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
          chrome.tabs.sendMessage(tabs[0].id, {message: "clear-spinner", href: request.href})
        })
      } else {
        chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
          chrome.tabs.sendMessage(tabs[0].id, {message: "download-stopped", id: request.id})
        })
      }
    }

    if (request.message === "set-state") {
      extensionEnabled = request.state === "on" ? true : false
      coverArt = request.coverArt === "on" ? true : false
      setIcon()
      chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
        chrome.tabs.sendMessage(tabs[0].id, {message: "update-state", state: request.state, coverArt: request.coverArt})
      })
    }
})

let historyUrl = ""

chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  if (historyUrl !== details.url) {
    chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
      playlistLock = false
      chrome.tabs.sendMessage(tabs[0].id, {message: "history-change"})
    })
  }
  historyUrl = details.url
})

setIcon()