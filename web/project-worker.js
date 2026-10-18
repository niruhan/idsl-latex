import {searchProject,outlineProject,bibliographyProject} from './project-analysis.js';
self.onmessage=event=>{try{const {operation,files,options}=event.data,run={search:searchProject,outline:outlineProject,bibliography:bibliographyProject}[operation];if(!run)throw Error('Unknown analysis.');self.postMessage({result:run(files,options)});}catch(error){self.postMessage({error:error.message});}};
