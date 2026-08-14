# Security policy

Report vulnerabilities privately to the repository owner before opening a public issue. Do not include API keys, private images, provider responses, or full configuration files in reports.

Cloud channels receive the bytes of each automatically converted Web attachment and each file explicitly passed to `vision_analyze`. `allowedRoots` confines only the explicit file-path tool; Web attachments are already validated and addressed through Harness's private attachment store. Keep keys in environment variables, prefer local OCR/VLMs for sensitive data, set `DS_VISION_AUTO_CONVERT=false` when automatic upload is inappropriate, and pin plugin revisions before team deployment.
