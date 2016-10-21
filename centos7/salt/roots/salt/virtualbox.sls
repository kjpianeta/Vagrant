virtualbox:
   pkg.installed:
     - fromrepo: managed_virtualbox

virtualbox.repo:
   pkgrepo.managed:
    - name: managed_virtualbox
    - humanname: Oracle Linux / RHEL / CentOS-$releasever / $basearch - VirtualBox
    - baseurl: http://download.virtualbox.org/virtualbox/rpm/el/$releasever/$basearch
    - gpgcheck: 1
    - gpgkey: https://www.virtualbox.org/download/oracle_vbox.asc
    - repo_gpgcheck: 1
    - enabled: 1