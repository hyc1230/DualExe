npx tsc
npx rollup -c
node --experimental-sea-config sea-config.json
cp $(command -v node) dist/dualexe-sea
npx postject dist/dualexe-sea NODE_SEA_BLOB dist/sea-prep.blob \
    --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2