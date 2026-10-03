# Fonts

`HindSiliguri-*.ttf`: Hind Siliguri by Indian Type Foundry (Copyright (c) 2015), a Bangla + Latin typeface
licensed under the SIL Open Font License 1.1 (full text in [OFL.txt](OFL.txt)). It is free to use in
commercial graphics. Downloaded from Google Fonts.

The image pipeline renders all Bangla text on images with these files (see `backend/src/imaging/overlay/text.js`),
so the result is the same on every computer and server, whatever fonts that machine has installed.
To use a different font, put its `.ttf` files here and change `fonts` in the brand file.
