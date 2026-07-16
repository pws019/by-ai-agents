# 训练计划
- 准备使用llamafactory进行模型训练，
- 训练的基座模型使用Qwen-3.预计在训练这个位置
  - /model/ModelScope/Qwen/Qwen3-8B
  - 训练目标是QLoRA 4bit NF4
- 训练的数据准备在该项目的data文件夹中
- 安装llamafactory相关的资源，你可以放在该customer-service-qlora目录下
- 登录云主机后，先利用git将文件信息clone下来，
- 在云主机上训练完成后，通过git同步更新到git仓库

# 参考文档
安装地址：
https://llamafactory.readthedocs.io/en/latest/getting_started/installation.html
数据训练：
https://llamafactory.readthedocs.io/en/latest/getting_started/data_preparation.html#id4