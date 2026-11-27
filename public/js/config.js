export const config = {
  adapter: "auto",
  // adapter 'artifact-db' (or 'auto' inside a Claude artifact).
  //   scope: 'private'  your workspace lives in your own private subtree; nobody else can read it,
  //                     not even the artifact's owner. Each person who opens the link gets their own.
  //   scope: 'shared'   one workspace for everyone the artifact admits; access follows the
  //                     artifact's db rules (see README).
  artifactDb: { scope: "private" },
  // Only read when adapter is 'firebase'. Copy these from
  // Firebase console -> Project settings -> Your apps -> Web app.
  firebase: {
    apiKey: "",
    authDomain: "",
    projectId: "",
    appId: ""
  }
};
