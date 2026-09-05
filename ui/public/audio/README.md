# Session announcement recordings

| Voice | File | Spoken text |
| --- | --- | --- |
| Microsoft Zira | `premarket-open.mp3` | Pre-market is now open. |
| Microsoft Zira | `market-open.mp3` | Market is now open. |
| Google US English | `premarket-open-google.mp3` | Pre-market is now open. |
| Google US English | `market-open-google.mp3` | Market is now open. |

Generated locally with Windows **Microsoft Zira Desktop** (`en-US`, female),
using `System.Speech.Synthesis.SpeechSynthesizer`: `Rate = 0`, `Volume = 100`,
`Speak(text)`, and `SetOutputToWaveFile(path)`. No music or chime is mixed in.

The WAV output was converted with FFmpeg to mono 24 kHz, 64 kbps MP3:

```sh
ffmpeg -i source.wav -af "loudnorm=I=-18:TP=-2:LRA=7" -ar 24000 -ac 1 -c:a libmp3lame -b:a 64k output.mp3
```

These are fixed audio assets: playback does not require an installed voice,
network access, or a speech API. Vite copies them to `dist/audio/`; the release
build embeds that directory with the rest of the UI.

The Google US English clips were extracted from the supplied `voice.mp4` screen
recording of the `fill-sounds.html` voice cards. The first speech segment is
the Market-open card and the second is the Pre-market card; the surrounding
screen-recording silence was trimmed.
