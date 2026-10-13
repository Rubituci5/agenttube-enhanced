'use strict';
/**
 * Rebase legacy absolute Mac file paths AFTER restoring SQLite and media to
 * /opt/agenttube on Linux. Dry-run default, no mutations.
 *
 * node scripts/server/rebase-paths.js --old-root '/Users/username/Documents/YOUTUBE AGENT'
 * DEPLOYMENT_MODE=server MIGRATION_OFFLINE_CONFIRMED=yes node scripts/server/rebase-paths.js --apply --old-root ...
 *
 * Apply creates consistent SQLite snapshot using VACUUM INTO before changes,
 * then wraps all path replacements in one transaction. Requires stopped service.
 */
const fs=require('node:fs');
const path=require('node:path');
const sqlite3=require('sqlite3');
const ROOT=path.resolve(__dirname,'../..');
const DEFAULT_OLD='/Users/rubituci/Documents/YOUTUBE AGENT';
const args=process.argv.slice(2);
function getArg(label,fallback){
  const i=args.indexOf(label);
  return i>=0?args[i+1]:fallback;
}
const oldRoot=getArg('--old-root',DEFAULT_OLD);
const newRoot=getArg('--new-root',ROOT);
const apply=args.includes('--apply');
const dbPath=path.join(ROOT,'data','youtube_automation.db');
const safeIdentifier=x=>/^[A-Za-z_][A-Za-z0-9_]*$/.test(x);
async function sqlite(file,mode){
  return new Promise((resolve,reject)=>{
    const connection=new sqlite3.Database(file,mode,e=>e?reject(e):resolve(connection))
  })
}
async function all(db,sql,params=[]){
  return new Promise((resolve,reject)=>db.all(sql,params,(err,result)=>err?reject(err):resolve(result)))
}
async function run(db,sql,params=[]){
  return new Promise((resolve,reject)=>db.run(sql,params,err=>err?reject(err):resolve()))
}
async function main(){
 if(oldRoot===newRoot&&apply)throw Error('Destino é igual à origem, nada a migrar.');
 if(!oldRoot.startsWith('/')||!newRoot.startsWith('/')||
    oldRoot.length<8||newRoot.length<8)throw Error('Forneça caminhos absolutos de origem e destino.');
 if(!fs.existsSync(dbPath))throw Error('Base SQLite ausente no destino.');
 if(apply&&(process.platform!=='linux'||process.env.DEPLOYMENT_MODE!=='server'||
    process.env.MIGRATION_OFFLINE_CONFIRMED!=='yes')){
   throw Error('Reescrita permitida somente no Linux, com serviço PARADO e confirmação MIGRATION_OFFLINE_CONFIRMED=yes.');
 }
 const db=await sqlite(dbPath,apply?sqlite3.OPEN_READWRITE:sqlite3.OPEN_READONLY);
 try{
   const tables=await all(db,"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
   const changes=[];
   for(const {name} of tables){
     if(!safeIdentifier(name))continue;
     const columns=await all(db,`PRAGMA table_info("${name}")`);
     for(const col of columns){
       if(!safeIdentifier(col.name)||!/TEXT|CHAR|CLOB/i.test(String(col.type||'')))continue;
       const rows=await all(db,`SELECT COUNT(*) AS count FROM "${name}"
         WHERE instr(COALESCE("${col.name}",''),?) > 0`,[oldRoot]);
       if(rows[0]?.count)changes.push({table:name,column:col.name,rows:rows[0].count});
     }
   }
   console.log('PATH_MIGRATION_SCAN',JSON.stringify({
     oldRoot,newRoot,apply,columns:changes.length,
     affectedRows:changes.reduce((sum,item)=>sum+item.rows,0),changes
   }));
   if(!apply){
     console.log('DRY_RUN_ONLY: original database unchanged.');
     return;
   }
   if(!changes.length){console.log('ALREADY_MIGRATED: no paths to update.');return;}
   const backup=dbPath+'.pre-path-migration-'+new Date().toISOString().replace(/[:.]/g,'-')+'.bak';
   // Online-consistent SQLite copy via VACUUM INTO, before any rewrite.
   await run(db,'VACUUM INTO ?',[backup]);
   fs.chmodSync(backup,0o600);
   if(fs.statSync(backup).size<10000)throw Error('Backup de banco incompleto.');
   console.log('SQLITE_BACKUP_CREATED',backup);
   await run(db,'BEGIN IMMEDIATE');
   try{
     for(const change of changes){
       await run(db,`UPDATE "${change.table}" SET "${change.column}" =
         REPLACE("${change.column}", ?, ?) WHERE instr("${change.column}", ?) > 0`,
        [oldRoot,newRoot,oldRoot]);
     }
     const check=await all(db,'PRAGMA quick_check');
     if(check?.[0]?.quick_check!=='ok')throw Error('SQLite integrity check failed after migration.');
     await run(db,'COMMIT');
   }catch(error){
     await run(db,'ROLLBACK').catch(()=>{});
     throw error;
   }
   console.log('PATH_MIGRATION_COMMITTED',changes.length,'columns',changes.reduce((s,v)=>s+v.rows,0),'rows');
 }finally{await new Promise(resolve=>db.close(()=>resolve()))}
}
main().catch(error=>{console.error('PATH_MIGRATION_FAILED',String(error.message).slice(0,450));process.exitCode=2});
