{
  "targets": [
    {
      "target_name": "audio_capture",
      "sources": ["src/capture.cc"],
      # <!( a nie <!@( — <!@ dzieli wynik po spacjach, a sciezka projektu
      # zawiera spacje ("Inne rzeczy") i rozpadlaby sie na dwa katalogi.
      "include_dirs": ["<!(node -p \"require('node-addon-api').include_dir\")"],
      "defines": ["NAPI_VERSION=8", "NAPI_DISABLE_CPP_EXCEPTIONS"],
      "libraries": ["ole32.lib", "mmdevapi.lib"],
      "msvs_settings": {
        "VCCLCompilerTool": {
          "ExceptionHandling": 1
        }
      }
    }
  ]
}
