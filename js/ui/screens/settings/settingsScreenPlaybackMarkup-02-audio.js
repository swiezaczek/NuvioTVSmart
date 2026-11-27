/* eslint-disable no-unused-vars */
import * as internals from "./settingsScreenContext.js";

export function renderPlaybackAudioBody(model) {
  const { t, labelForPlaybackLanguage } = internals;
  return `
          <div class="settings-stack">
            ${this.renderToggleRow({
              focusKey: "playback:trailer",
              title: t("settings.playback.autoplayTrailer.title"),
              subtitle: t("settings.playback.autoplayTrailer.subtitle"),
              checked: Boolean(model.player.trailerAutoplay)
            })}
            ${model.player.trailerAutoplay ? this.renderActionRow({ focusKey: "playback:trailerDelay", title: t("audio_trailer_delay"), subtitle: t("audio_trailer_delay_sub", {}, "Delay before trailer playback starts"), value: `${model.player.trailerDelaySeconds ?? 7}s` }) : ""}
            ${this.renderToggleRow({
              focusKey: "playback:vetroDirectTrailers",
              title: t("settings.playback.vetroDirectTrailers.title", {}, "Direct Ad-Free Trailers (Vetro)"),
              subtitle: t(
                "settings.playback.vetroDirectTrailers.subtitle",
                {},
                "Use local Vetro trailer resolver (local port 8102) when available"
              ),
              checked: model.player.vetroDirectTrailersEnabled !== false
            })}
            ${this.renderActionRow({
              focusKey: "playback:audioLanguage",
              title: t("settings.playback.preferredAudio.title"),
              subtitle: t("settings.playback.preferredAudio.subtitle"),
              value: labelForPlaybackLanguage(model.player.preferredAudioLanguage)
            })}
            ${this.renderActionRow({
              focusKey: "playback:secondaryAudioLanguage",
              title: t("sub_secondary_lang", {}, "Secondary Preferred Language"),
              subtitle: t("settings.playback.preferredAudio.subtitle", {}, "Choose the audio language to prefer when it is available."),
              value: labelForPlaybackLanguage(model.player.secondaryPreferredAudioLanguage)
            })}
          </div>
        `;
}
