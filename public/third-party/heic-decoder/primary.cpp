#include <libheif/heif.h>
#include <cstdio>
#include <cstdint>
#include <cinttypes>
#include <limits>

int main(int argc,char** argv) {
 if (argc != 3) return 2;
 auto* ctx=heif_context_alloc(); if(!ctx) return 3;
 heif_image_handle* handle=nullptr; heif_image* image=nullptr; FILE* fp=nullptr; int result=4;
 auto* limit=heif_context_get_security_limits(ctx);
 limit->max_image_size_pixels=40000000;
 limit->max_memory_block_size=192ull*1024*1024;
 limit->max_total_memory=384ull*1024*1024;
 auto err=heif_context_read_from_file(ctx,argv[1],nullptr);
 if (err.code) goto done;
 err=heif_context_get_primary_image_handle(ctx,&handle);
 if (err.code||!handle) goto done;
 {int w=heif_image_handle_get_width(handle),h=heif_image_handle_get_height(handle);
 if(w<1||h<1||w>16384||h>16384||uint64_t(w)*uint64_t(h)>40000000) goto done;}
 err=heif_decode_image(handle,&image,heif_colorspace_RGB,heif_chroma_interleaved_RGBA,nullptr);
 if (err.code||!image) goto done;
 {int w=heif_image_get_width(image,heif_channel_interleaved),h=heif_image_get_height(image,heif_channel_interleaved);
 if(w<1||h<1||w>16384||h>16384||uint64_t(w)*uint64_t(h)>40000000) goto done;
 size_t stride=0; const uint8_t* data=heif_image_get_plane_readonly2(image,heif_channel_interleaved,&stride);
 if(!data||stride<size_t(w)*4||stride>std::numeric_limits<size_t>::max()/size_t(h)) goto done;
 fp=fopen(argv[2],"wb");if(!fp)goto done;
 uint32_t dims[2]={(uint32_t)w,(uint32_t)h}; if(fwrite(dims,sizeof(uint32_t),2,fp)!=2)goto done;
 for(int y=0;y<h;y++){if(fwrite(data+size_t(y)*stride,4,(size_t)w,fp)!=(size_t)w)goto done;}
 if(fclose(fp)!=0){fp=nullptr;goto done;}fp=nullptr;
 printf("PRIMARY_RGBA width=%d height=%d bytes=%" PRIu64 "\n",w,h,uint64_t(w)*uint64_t(h)*4);result=0;}
 done: if(fp)fclose(fp);if(image)heif_image_release(image);if(handle)heif_image_handle_release(handle);heif_context_free(ctx);return result;
}
