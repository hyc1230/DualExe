echo "(1/4) Compile TS to JS"
npx tsc
echo "------------------------------"
echo "(2/4) Bundle JS"
npx rollup --format=cjs --file=dist/bundle.js --plugin node-resolve --plugin commonjs -- dist/index.js
echo "------------------------------"
echo "(3/4) Generate SEA"
node --experimental-sea-config sea-config.json
cp $(command -v node) dist/dualexe-sea
npx postject dist/dualexe-sea NODE_SEA_BLOB dist/sea-prep.blob \
    --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
echo "------------------------------"
echo "(4/4) Done!"