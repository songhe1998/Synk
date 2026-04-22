import { ResultLoadingShell } from "@/components/result-loading-shell";

export default function Loading() {
  return (
    <ResultLoadingShell
      label="Image"
      title="Opening your image"
      copy="Loading the generated image and its details."
    />
  );
}
