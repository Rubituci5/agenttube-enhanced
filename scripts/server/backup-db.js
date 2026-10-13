'use strict';
/**
 * Consistent SQLite snapshot before migration. Does not pause or mutate
 * the live DB. Tokens, API keys and personal assets are not printed.
 */
const fs=require('node:fs/promises');
const path=require('node:path');
const sqlite3=require('sqlite3');
const ROOT=path.resolve(__dirname,'../..');
const SOURCE=path.join(ROOT,'data','youtube_automation.db');
const OUTPUT=path.join(ROOT,'data','backups');
async function main(){
  await fs.mkdir(OUTPUT,{recursive:true,mode:0o700});
  const target=path.join(OUTPUT,'agenttube-sqlite-'+new Date().toISOString().replace(/[:.]/g,'-')+'.db.backup');
  const db=await new Promise((resolve,reject)=>{
    const handle=new sqlite3.Database(SOURCE,sqlite3.OPEN_READONLY,e=>e?reject(e):resolve(handle))
  });
  try{
    await new Promise((resolve,reject)=>db.run('VACUUM INTO ?',[target],e=>e?reject(e):resolve()));
    await fs.chmod(target,0o600);
  }catch(error){
    await fs.rm(target,{force:true}).catch(()=>{});
    throw error;
  }finally{await new Promise(ok=>db.close(()=>ok()))}
  const verify=await new Promise((resolve,reject)=>{
    const handle=new sqlite3.Database(target,sqlite3.OPEN_READONLY,e=>e?reject(e):resolve(handle))
  });
  try{
    const result=await new Promise((resolve,reject)=>verify.get('PRAGMA quick_check',[],(e,row)=>e?reject(e):resolve(row)));
    if(result?.quick_check!=='ok')throw Error('Backup integrity check failed');
  }finally{await new Promise(ok=>verify.close(()=>ok()))}
  console.log('SQLITE_SAFE_BACKUP_OK',JSON.stringify({path:target,sizeBytes:(await fs.stat(target)).size,integrity:'ok'}));
}
main().catch(e=>{console.error('SQLITE_BACKUP_FAILED',e.message);process.exitCode=1});
