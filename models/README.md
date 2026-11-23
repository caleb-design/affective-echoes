# Models

The app's built-in language model lives here.

**File:** `Llama-3.2-3B-Instruct-Q4_K_M.gguf` (about 2 GB)

- **Windows release zip:** already included. Nothing to do.
- **Running from source:** start the app and click **Download model** in the console's
  system check, or download the file yourself from
  https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF
  (pick `Llama-3.2-3B-Instruct-Q4_K_M.gguf`) and put it in this folder.

To try a different GGUF model, put it here and remove the default one, or set
`AE_MODEL_PATH=C:\path\to\model.gguf` in `.env`. Small instruct models (1–4B) work best on
laptops; larger ones may be too slow on a CPU.

Model files are not stored in the code repository (they're too large); the release build
adds them.
