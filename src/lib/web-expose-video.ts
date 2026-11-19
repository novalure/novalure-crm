export function webExposeVideoEmbed(raw:string):string|null{
  try{
    const url=new URL(raw); if(url.protocol!=="https:"||url.username||url.password)return null;
    let id:string|null=null;
    if(["youtube.com","www.youtube.com","m.youtube.com","youtube-nocookie.com","www.youtube-nocookie.com"].includes(url.hostname)) id=url.pathname.startsWith("/embed/")?url.pathname.split("/")[2]:url.pathname.startsWith("/shorts/")?url.pathname.split("/")[2]:url.searchParams.get("v");
    if(url.hostname==="youtu.be")id=url.pathname.split("/")[1];
    if(id&&/^[A-Za-z0-9_-]{6,30}$/.test(id))return `https://www.youtube-nocookie.com/embed/${id}`;
    if(["vimeo.com","www.vimeo.com","player.vimeo.com"].includes(url.hostname)){const videoId=url.pathname.split("/").filter(Boolean).at(-1);if(videoId&&/^\d{4,20}$/.test(videoId))return `https://player.vimeo.com/video/${videoId}?dnt=1`;}
    return null;
  }catch{return null;}
}
