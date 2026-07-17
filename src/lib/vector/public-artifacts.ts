const VECTOR_PUBLIC_FILES = new Set([
  "/sw.js",
  "/vector-offline.html",
]);

const VECTOR_PUBLIC_DIRECTORIES = [
  "/vector-assets/",
];

export function isPublicVectorArtifactPath(pathname: string): boolean {
  return (
    VECTOR_PUBLIC_FILES.has(pathname) ||
    VECTOR_PUBLIC_DIRECTORIES.some((prefix) => pathname.startsWith(prefix))
  );
}
