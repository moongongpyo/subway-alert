import {readdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
for(const dir of ['src','public','sandbox','scripts','test'])for(const file of readdirSync(dir))if(/\.(m?js)$/.test(file))execFileSync(process.execPath,['--check',join(dir,file)],{stdio:'inherit'});
console.log('JavaScript syntax checked.');
