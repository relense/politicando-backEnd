class ChangeColumnInArticles < ActiveRecord::Migration[5.2]
  def change
    change_column :articles, :content, :text
  end
end
