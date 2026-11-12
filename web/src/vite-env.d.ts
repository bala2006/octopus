/// <reference types="vite/client" />
declare module "monaco-workers/*?worker" {
  const WorkerFactory: { new (): Worker };
  export default WorkerFactory;
}
