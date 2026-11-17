const IMAGE = /\.(png|jpe?g|gif|webp|ico|bmp|svg)$/i;

/** Files the editor draws as a picture. Their bytes never load as text. */
export function isImagePath(path: string): boolean {
  return IMAGE.test(path);
}
