let token=sessionStorage.getItem('admin_token')||'';
const box=document.querySelector('#loginBox'),app=document.querySelector('#adminApp'),msg=document.querySelector('#adminMsg');
const headers=()=>({authorization:'Bearer '+token,'content-type':'application/json'});
document.querySelector('#saveToken').onclick=()=>{token=document.querySelector('#adminToken').value.trim();sessionStorage.setItem('admin_token',token);openAdmin()};
document.querySelector('#generate').onclick=generate;
async function request(url,options={}){const r=await fetch(url,{...options,headers:{...headers(),...(options.headers||{})}});const d=await r.json().catch(()=>({ok:false,error:'服务器返回异常。'}));if(r.status===401)throw new Error('Token 不正确。');return d;}
async function openAdmin(){
 try{
  const [codes,tests]=await Promise.all([request('/api/admin/codes'),request('/api/admin/tests')]);
  if(!codes.ok)throw new Error(codes.error||'无法读取验证码。');
  if(!tests.ok)throw new Error(tests.error||'无法读取测试。');
  box.hidden=true;app.hidden=false;
  const select=document.querySelector('#testSlug');select.innerHTML=tests.tests.filter(t=>t.enabled).map(t=>`<option value="${t.slug}">${t.title}</option>`).join('');
  render(codes);
 }catch(e){msg.textContent=e.message;box.hidden=false;app.hidden=true;}
}
async function generate(){
 const quantity=Number(document.querySelector('#qty').value||1),testSlug=document.querySelector('#testSlug').value,note=document.querySelector('#note').value.trim();
 const d=await request('/api/admin/codes',{method:'POST',body:JSON.stringify({quantity,testSlug,note})});
 if(!d.ok)return alert(d.error||'生成失败。');
 const c=document.querySelector('#created');c.hidden=false;c.innerHTML='<b>刚生成的验证码：</b><br>'+d.codes.map(x=>`<code>${x.code}</code>`).join(' ');
 openAdmin();
}
function render(d){
 document.querySelector('#rows').innerHTML=d.codes.map(c=>`<tr><td><b>${c.code_preview}</b></td><td>${c.test_title||c.test_slug}</td><td>${c.status}</td><td>${new Date(Number(c.created_at)).toLocaleString()}</td><td>${c.expires_at?new Date(Number(c.expires_at)).toLocaleString():'未激活'}</td><td>${c.device_count}/${c.max_devices}</td><td>${c.status!=='revoked'?`<button class="op" onclick="revokeCode(${c.id})">作废</button>`:''}<button class="op" onclick="extendCode(${c.id})">延长48h</button><button class="op" onclick="showDevices(${c.id})">设备</button></td></tr>`).join('');
}
async function extendCode(id){const d=await request('/api/admin/codes/'+id+'/extend',{method:'POST',body:JSON.stringify({hours:48})});if(!d.ok)alert(d.error||'操作失败');openAdmin();}
async function revokeCode(id){if(!confirm('确定作废这个验证码？'))return;const d=await request('/api/admin/codes/'+id+'/revoke',{method:'POST'});if(!d.ok)alert(d.error||'操作失败');openAdmin();}
async function showDevices(id){const d=await request('/api/admin/codes/'+id+'/devices');if(!d.devices?.length)return alert('还没有绑定设备。');alert(d.devices.map((x,i)=>(i+1)+'. '+(x.user_agent||'未知设备')+'\n最后使用：'+new Date(Number(x.last_seen_at)).toLocaleString()).join('\n\n'));}
if(token)openAdmin();
