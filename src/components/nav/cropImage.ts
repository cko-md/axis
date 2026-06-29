import type { Area } from "react-easy-crop";

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not load image"));
    img.src = src;
  });
}

/** Crops `imageSrc` to `crop` (pixel rect from react-easy-crop) and re-encodes as a square JPEG. */
export async function getCroppedImageBlob(
  imageSrc: string,
  crop: Area,
  outputSize = 512,
): Promise<Blob> {
  const image = await loadImage(imageSrc);
  const canvas = document.createElement("canvas");
  canvas.width = outputSize;
  canvas.height = outputSize;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is not supported");

  // Fill white first — JPEG has no alpha channel, so a transparent source
  // (e.g. a PNG logo) would otherwise render as black in some browsers.
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, outputSize, outputSize);
  ctx.drawImage(image, crop.x, crop.y, crop.width, crop.height, 0, 0, outputSize, outputSize);

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Could not encode cropped image"))),
      "image/jpeg",
      0.92,
    );
  });
}
