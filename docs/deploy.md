# Putting it online (Vercel, free)

The app is plain files. There is no server to run and nothing to configure.

1. **Make a GitHub repository** for this folder (new, public) and upload the files. Private notes (`handwriting-font.md`) are already excluded by `.gitignore`.
2. Go to <https://vercel.com>, sign in **with GitHub**, choose **Add New → Project**, and pick the repository.
3. Leave every setting as it is (Framework: *Other*, no build command, no output directory) and press **Deploy**.
4. In about a minute you get a link like `https://your-name.vercel.app`. Open it on your phone and run the sample sheet.
5. Put that link in the README's *Open the app* button, and in `FEEDBACK_URL` at the top of `src/app.js` (the repo's *Issues* page) so the "Tell me" link in the footer appears.

Every time you push a change to GitHub, Vercel republishes automatically.

## Things to check on a real phone after the first deploy

- *Take a photo* opens the camera, and the photo reads correctly.
- *Share…* opens the phone's share sheet and sends the picture.
- *Get the font* then *Send it to myself…* offers Drive or email (some phones only offer a normal download).
- Come back after closing the tab: your handwriting is still there.
- The text box shows your handwriting as you type.

## Optional: counting visitors

Vercel has a free, cookie-free visit counter (**Analytics** tab → Enable). It counts page visits only and does not store anything about people. No code changes are needed.
