import { repository } from "../packages/oci/publish.ts";
import { conformanceOptions } from "./registry-conformance.ts";

if (import.meta.main) {
  const options = conformanceOptions(), ref = repository(options.repo);
  console.log(`host=${ref.registry}`);
  if (options.vendor === "ecr") {
    console.log(`region=${ref.registry.split(".")[3]}`);
    console.log(`account=${ref.registry.split(".")[0]}`);
  }
}
