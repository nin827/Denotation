export const config = {
  version: "0.1", // app version shown in Settings; keep in step with package.json
  adapter: "auto",
  // adapter 'artifact-db' (or 'auto' inside a Claude artifact).
  //   scope: 'private'  your workspace lives in your own private subtree; nobody else can read it,
  //                     not even the artifact's owner. Each person who opens the link gets their own.
  //   scope: 'shared'   one workspace for everyone the artifact admits; access follows the
  //                     artifact's db rules (see README).
  artifactDb: { scope: "private" },
  // Cloud storage locations (Storage -> Add location). Client IDs are public; leave "" to hide the option
  // ("Not configured"). The site owner creates them once (see README_INSTRUCTION.md, Storage):
  //   google:    Google Cloud console -> OAuth client ID, type "Web application", authorized JavaScript origin =
  //              the site's origin, authorized redirect URI = the app's URL (e.g. https://<user>.github.io/<repo>/).
  //   microsoft: Microsoft Entra admin center -> App registrations, platform "Single-page application",
  //              redirect URI = the app's URL; supported accounts: personal + work/school.
  // redirectUri: leave "" to use the app's own URL (without index.html).
  oauth: {
    google: { clientId: "1017390894798-dnn9mk7pudq7a9pe9anfqjqqusc0m8r0.apps.googleusercontent.com" },
    microsoft: { clientId: "" },
    redirectUri: ""
  },
  // Only read when adapter is 'firebase'. Copy these from
  // Firebase console -> Project settings -> Your apps -> Web app.
  firebase: {
    apiKey: "",
    authDomain: "",
    projectId: "",
    appId: ""
  }
};
